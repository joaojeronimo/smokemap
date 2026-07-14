// SmokeMap - Application Logic

document.addEventListener('DOMContentLoaded', () => {
    // --- State Management ---
    const state = {
        map: null,
        selectedMode: 'worst', // 'worst' or 'current'
        selectedStyle: 'dark', // 'dark' or 'light'
        selectedCell: null,    // { bounds: L.LatLngBounds, data: Object, latCenter: Number, lngCenter: Number }
        gridCells: {},         // Key: 'lat_lng', Value: { rectangle: L.Rectangle, data: Object }
        cache: {},             // Key: 'lat_lng', Value: { timestamp: Number, data: Object }
        cacheTTL: 60 * 60 * 1000, // 1 hour in milliseconds
        searchTimeout: null,
        debouncedFetchTimeout: null,
        currentHighlight: null, // Highlighted selected cell rectangle
        userCoords: null       // User's physical location
    };

    // --- Configuration Constants ---
    const BERKELEY_EARTH_PM25_FACTOR = 22; // 22 ug/m3 PM2.5 = 1 cigarette per day

    // Base Map Tiles URLs
    const MAP_LAYERS = {
        dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 20
        }),
        light: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 20
        })
    };

    // --- Initialize Application ---
    function init() {
        // Initialize Lucide Icons
        lucide.createIcons();

        // Load Cache from LocalStorage
        try {
            const savedCache = localStorage.getItem('smokemap_aqi_cache');
            if (savedCache) {
                state.cache = JSON.parse(savedCache);
                cleanExpiredCache();
            }
        } catch (e) {
            console.error('Failed to load cache from localStorage:', e);
        }

        // Default location: London
        const defaultLat = 51.505;
        const defaultLng = -0.09;
        const defaultZoom = 11;

        // Initialize Map (disable default zoom control, we position it custom)
        state.map = L.map('map', {
            zoomControl: true,
            layers: [MAP_LAYERS.dark] // Default
        }).setView([defaultLat, defaultLng], defaultZoom);

        // Position Zoom Control to Bottom Right (above legend on mobile)
        state.map.zoomControl.setPosition('bottomright');

        // Locate User Immediately
        attemptGeolocation();

        // Register Event Listeners
        registerMapEvents();
        registerUIEvents();
    }

    // --- Geolocation ---
    function attemptGeolocation() {
        if ('geolocation' in navigator) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const lat = position.coords.latitude;
                    const lng = position.coords.longitude;
                    state.userCoords = { lat, lng };
                    state.map.setView([lat, lng], 12);
                    
                    // Add a tiny subtle user location circle
                    L.circle([lat, lng], {
                        color: 'var(--primary)',
                        fillColor: 'var(--primary)',
                        fillOpacity: 0.15,
                        radius: 150,
                        weight: 2
                    }).addTo(state.map);
                },
                (error) => {
                    console.log('Geolocation declined or failed. Defaulting to London.', error);
                },
                { enableHighAccuracy: true, timeout: 5000 }
            );
        }
    }

    // --- Event Listeners Registration ---
    function registerMapEvents() {
        // Fetch new grid data when map is panned or zoomed
        state.map.on('moveend', () => {
            debouncedUpdateGrid();
        });

        // Close details drawer if clicking on map background
        state.map.on('click', (e) => {
            // Only close if we didn't click a grid cell
            // Leaflet propagates grid cell clicks, but we stopPropagation there.
            closeDetailsDrawer();
        });

        // Trigger initial grid load once map is ready
        setTimeout(updateGrid, 100);
    }

    function registerUIEvents() {
        // Toggle Overlay Mode: Worst vs Current
        document.getElementById('mode-worst').addEventListener('click', (e) => {
            switchMode('worst');
        });
        document.getElementById('mode-current').addEventListener('click', (e) => {
            switchMode('current');
        });

        // Toggle Map Style: Dark vs Light
        document.getElementById('style-dark').addEventListener('click', () => {
            switchStyle('dark');
        });
        document.getElementById('style-light').addEventListener('click', () => {
            switchStyle('light');
        });

        // Info Button & Modal Dialog
        const infoModal = document.getElementById('info-modal');
        document.getElementById('legend-info-btn').addEventListener('click', () => {
            infoModal.showModal();
        });
        document.getElementById('close-modal').addEventListener('click', () => {
            infoModal.close();
        });
        infoModal.addEventListener('click', (e) => {
            // Close modal if clicked outside the container
            if (e.target === infoModal) {
                infoModal.close();
            }
        });

        // Details Drawer Close Button
        document.getElementById('close-drawer').addEventListener('click', closeDetailsDrawer);

        // Mobile Bottom Sheet Drag to Dismiss
        const drawer = document.getElementById('detail-drawer');
        const handle = drawer.querySelector('.drawer-drag-handle');
        let startY = 0;
        let currentY = 0;
        let isDragging = false;

        handle.addEventListener('touchstart', (e) => {
            startY = e.touches[0].clientY;
            isDragging = true;
            drawer.style.transition = 'none';
        });

        handle.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            currentY = e.touches[0].clientY;
            const diffY = currentY - startY;
            
            // Only allow dragging downwards to dismiss
            if (diffY > 0) {
                drawer.style.transform = `translateY(${diffY}px)`;
            }
        });

        handle.addEventListener('touchend', (e) => {
            if (!isDragging) return;
            isDragging = false;
            drawer.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
            
            const diffY = currentY - startY;
            const threshold = window.innerHeight * 0.2; // 20% of screen height
            
            if (diffY > threshold) {
                closeDetailsDrawer();
            } else {
                drawer.style.transform = 'translateY(0)';
            }
        });

        // Geocoding Search Input
        const searchInput = document.getElementById('search-input');
        const clearBtn = document.getElementById('clear-search');
        
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            if (query.length > 0) {
                clearBtn.classList.remove('hidden');
                debounceSearch(query);
            } else {
                clearBtn.classList.add('hidden');
                hideSearchResults();
            }
        });

        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            clearBtn.classList.add('hidden');
            hideSearchResults();
            searchInput.focus();
        });

        // Brand click returns to current location
        document.querySelector('.brand').addEventListener('click', () => {
            if (state.userCoords) {
                state.map.setView([state.userCoords.lat, state.userCoords.lng], 12);
            } else {
                attemptGeolocation();
            }
        });

        // Geolocation Button click
        document.getElementById('locate-btn').addEventListener('click', attemptGeolocation);
    }

    // --- Overlay Mode Toggle ---
    function switchMode(mode) {
        if (state.selectedMode === mode) return;
        state.selectedMode = mode;
        
        document.getElementById('mode-worst').classList.toggle('active', mode === 'worst');
        document.getElementById('mode-current').classList.toggle('active', mode === 'current');
        
        // Re-render cell colors on the map
        Object.values(state.gridCells).forEach(cell => {
            const style = getCellColorStyle(cell.data);
            cell.rectangle.setStyle({
                fillColor: style.color,
                fillOpacity: style.opacity
            });
        });

        // Update detail drawer if open
        if (state.selectedCell) {
            updateDrawerUI(state.selectedCell.data, state.selectedCell.latCenter, state.selectedCell.lngCenter);
        }
    }

    // --- Map Style Toggle ---
    function switchStyle(theme) {
        if (state.selectedStyle === theme) return;
        state.selectedStyle = theme;
        
        document.getElementById('style-dark').classList.toggle('active', theme === 'dark');
        document.getElementById('style-light').classList.toggle('active', theme === 'light');
        
        document.body.classList.toggle('light-theme', theme === 'light');

        if (theme === 'light') {
            state.map.removeLayer(MAP_LAYERS.dark);
            state.map.addLayer(MAP_LAYERS.light);
        } else {
            state.map.removeLayer(MAP_LAYERS.light);
            state.map.addLayer(MAP_LAYERS.dark);
        }
    }

    // --- Search Autocomplete ---
    function debounceSearch(query) {
        clearTimeout(state.searchTimeout);
        state.searchTimeout = setTimeout(() => {
            fetchSearchSuggestions(query);
        }, 350);
    }

    async function fetchSearchSuggestions(query) {
        if (!query) return;
        
        try {
            // Nominatim API Search (identified as SmokeMap)
            const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`, {
                headers: {
                    'User-Agent': 'SmokeMap/1.0 (Web Air Quality overlay project)'
                }
            });
            
            if (!response.ok) throw new Error('Nominatim request failed');
            
            const results = await response.json();
            displaySearchResults(results);
        } catch (e) {
            console.error('Error fetching geocoding suggestions:', e);
        }
    }

    function displaySearchResults(results) {
        const panel = document.getElementById('search-results');
        panel.innerHTML = '';
        
        if (results.length === 0) {
            const noResults = document.createElement('div');
            noResults.className = 'search-item';
            noResults.style.cursor = 'default';
            noResults.innerHTML = `<i data-lucide="info"></i><span class="search-item-text">No locations found</span>`;
            panel.appendChild(noResults);
            lucide.createIcons();
            panel.classList.remove('hidden');
            return;
        }

        results.forEach(item => {
            const btn = document.createElement('button');
            btn.className = 'search-item';
            btn.innerHTML = `
                <i data-lucide="map-pin"></i>
                <span class="search-item-text">${item.display_name}</span>
            `;
            
            btn.addEventListener('click', () => {
                const lat = parseFloat(item.lat);
                const lon = parseFloat(item.lon);
                state.map.setView([lat, lon], 12);
                hideSearchResults();
                document.getElementById('search-input').value = item.display_name;
            });
            
            panel.appendChild(btn);
        });

        lucide.createIcons();
        panel.classList.remove('hidden');
    }

    function hideSearchResults() {
        document.getElementById('search-results').classList.add('hidden');
    }

    // --- Grid Overlay Logic ---
    function debouncedUpdateGrid() {
        clearTimeout(state.debouncedFetchTimeout);
        state.debouncedFetchTimeout = setTimeout(updateGrid, 400);
    }

    // Get grid cell size in degrees based on zoom level
    function getGridCellSize(zoom) {
        if (zoom >= 15) return 0.003; // Small cells (~300m)
        if (zoom >= 13) return 0.007; // ~700m
        if (zoom >= 11) return 0.015; // ~1.5km
        if (zoom >= 9)  return 0.04;  // ~4km
        if (zoom >= 7)  return 0.1;   // ~10km
        if (zoom >= 5)  return 0.3;   // ~30km
        return 0; // Disabled at very low zooms
    }

    async function updateGrid() {
        const bounds = state.map.getBounds();
        const zoom = state.map.getZoom();
        
        let cellSize = getGridCellSize(zoom);
        
        if (cellSize === 0) {
            // Zoomed out too far: clear overlay and inform user
            clearMapGrid();
            return;
        }

        // Calculate snapped grid coordinate bounds
        let minLat = Math.floor(bounds.getSouth() / cellSize) * cellSize;
        let maxLat = Math.ceil(bounds.getNorth() / cellSize) * cellSize;
        let minLng = Math.floor(bounds.getWest() / cellSize) * cellSize;
        let maxLng = Math.ceil(bounds.getEast() / cellSize) * cellSize;

        // Count cells to ensure we don't spam.
        // If there are too many cells in viewport, double the cell size to scale back.
        let latCount = Math.round((maxLat - minLat) / cellSize);
        let lngCount = Math.round((maxLng - minLng) / cellSize);
        let cellCount = latCount * lngCount;

        while (cellCount > 36) {
            cellSize *= 1.5;
            minLat = Math.floor(bounds.getSouth() / cellSize) * cellSize;
            maxLat = Math.ceil(bounds.getNorth() / cellSize) * cellSize;
            minLng = Math.floor(bounds.getWest() / cellSize) * cellSize;
            maxLng = Math.ceil(bounds.getEast() / cellSize) * cellSize;
            latCount = Math.round((maxLat - minLat) / cellSize);
            lngCount = Math.round((maxLng - minLng) / cellSize);
            cellCount = latCount * lngCount;
        }

        // Collect all viewport cell center coordinates
        const viewportKeys = new Set();
        const queueToFetch = [];

        for (let lat = minLat; lat < maxLat; lat += cellSize) {
            for (let lng = minLng; lng < maxLng; lng += cellSize) {
                // Ensure coordinate precision
                const cellLat = parseFloat(lat.toFixed(5));
                const cellLng = parseFloat(lng.toFixed(5));
                const key = `${cellLat}_${cellLng}`;
                viewportKeys.add(key);

                // Center of cell is where we query air quality
                const latCenter = parseFloat((cellLat + cellSize / 2).toFixed(5));
                const lngCenter = parseFloat((cellLng + cellSize / 2).toFixed(5));

                // If not in cache or cached expired, push to download queue
                if (!isCacheValid(key)) {
                    queueToFetch.push({ key, lat: latCenter, lng: lngCenter });
                }
            }
        }

        // Fetch missing data in batch (max 36 coordinates per request)
        if (queueToFetch.length > 0) {
            await fetchBatchAirQuality(queueToFetch);
        }

        // Render viewport cells on map
        renderViewportGrid(minLat, maxLat, minLng, maxLng, cellSize, viewportKeys);
    }

    // Remove cells no longer in view
    function clearMapGrid() {
        Object.keys(state.gridCells).forEach(key => {
            state.map.removeLayer(state.gridCells[key].rectangle);
            delete state.gridCells[key];
        });
    }

    // Render/draw grid rectangles
    function renderViewportGrid(minLat, maxLat, minLng, maxLng, cellSize, viewportKeys) {
        // 1. Remove out-of-bounds cells
        Object.keys(state.gridCells).forEach(key => {
            if (!viewportKeys.has(key)) {
                state.map.removeLayer(state.gridCells[key].rectangle);
                delete state.gridCells[key];
            }
        });

        // 2. Render viewport cells
        for (let lat = minLat; lat < maxLat; lat += cellSize) {
            for (let lng = minLng; lng < maxLng; lng += cellSize) {
                const cellLat = parseFloat(lat.toFixed(5));
                const cellLng = parseFloat(lng.toFixed(5));
                const key = `${cellLat}_${cellLng}`;

                const cached = state.cache[key];
                if (!cached) continue; // Skip if API fetch failed for this cell

                const data = cached.data;
                const style = getCellColorStyle(data);

                // If already drawn, just update styles (covers mode switches)
                if (state.gridCells[key]) {
                    state.gridCells[key].rectangle.setStyle({
                        fillColor: style.color,
                        fillOpacity: style.opacity
                    });
                    continue;
                }

                // Define Leaflet Rectangle bounds
                const cellBounds = L.latLngBounds(
                    [cellLat, cellLng],
                    [cellLat + cellSize, cellLng + cellSize]
                );

                const latCenter = parseFloat((cellLat + cellSize / 2).toFixed(5));
                const lngCenter = parseFloat((cellLng + cellSize / 2).toFixed(5));

                const rect = L.rectangle(cellBounds, {
                    color: 'rgba(255, 255, 255, 0.08)',
                    weight: 1,
                    fillColor: style.color,
                    fillOpacity: style.opacity,
                    stroke: true
                }).addTo(state.map);

                // Handle Grid Cell clicks
                rect.on('click', (e) => {
                    L.DomEvent.stopPropagation(e); // Stop map click listener triggering
                    selectGridCell(key, cellBounds, data, latCenter, lngCenter, rect);
                });

                state.gridCells[key] = {
                    rectangle: rect,
                    data: data
                };
            }
        }

        // Restore highlight if selected cell is still in view
        if (state.selectedCell && state.gridCells[state.selectedCell.key]) {
            highlightCell(state.gridCells[state.selectedCell.key].rectangle);
        }
    }

    // Highlight selected cell with active-cell class (creates stroke pulse)
    function highlightCell(rect) {
        if (state.currentHighlight) {
            state.currentHighlight.setStyle({
                color: 'rgba(255, 255, 255, 0.08)',
                weight: 1
            });
            // Remove SVG DOM class injection
            const pathEl = state.currentHighlight._path;
            if (pathEl) pathEl.classList.remove('active-cell-selection');
        }

        state.currentHighlight = rect;
        rect.setStyle({
            color: 'var(--primary)',
            weight: 3.5
        });

        // Inject pulse CSS class into leaflet SVG path element
        const pathEl = rect._path;
        if (pathEl) {
            pathEl.classList.add('active-cell-selection');
        }
    }

    // Remove active highlight
    function removeCellHighlight() {
        if (state.currentHighlight) {
            state.currentHighlight.setStyle({
                color: 'rgba(255, 255, 255, 0.08)',
                weight: 1
            });
            const pathEl = state.currentHighlight._path;
            if (pathEl) pathEl.classList.remove('active-cell-selection');
            state.currentHighlight = null;
        }
    }

    // --- Cell Selection / Details Opening ---
    async function selectGridCell(key, bounds, data, latCenter, lngCenter, rect) {
        state.selectedCell = { key, bounds, data, latCenter, lngCenter };
        
        highlightCell(rect);
        openDetailsDrawer();
        
        // 1. Instantly render numeric stats
        updateDrawerUI(data, latCenter, lngCenter);

        // 2. Perform background geocoding request to find name of clicked place
        try {
            const placeName = await reverseGeocode(latCenter, lngCenter);
            document.getElementById('location-name').textContent = placeName;
        } catch (e) {
            console.error('Failed to reverse geocode coordinate:', e);
            document.getElementById('location-name').textContent = `Grid Cell [${latCenter}, ${lngCenter}]`;
        }
    }

    function openDetailsDrawer() {
        const drawer = document.getElementById('detail-drawer');
        drawer.style.transform = 'translateY(0)'; // For mobile
        drawer.classList.add('open');
    }

    function closeDetailsDrawer() {
        const drawer = document.getElementById('detail-drawer');
        
        // Reset transforms
        if (window.innerWidth <= 768) {
            drawer.style.transform = 'translateY(100%)';
        } else {
            drawer.style.transform = 'translateX(-120%)';
        }
        
        drawer.classList.remove('open');
        state.selectedCell = null;
        removeCellHighlight();
    }

    // --- Geocoding Reverse ---
    async function reverseGeocode(lat, lng) {
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14`, {
            headers: {
                'User-Agent': 'SmokeMap/1.0 (Web Air Quality overlay project)'
            }
        });
        
        if (!response.ok) throw new Error('Reverse geocode failed');
        
        const res = await response.json();
        
        // Compose location details from Nominatim
        const addr = res.address;
        if (!addr) return `${lat}, ${lng}`;

        // Build nice human readable string
        const neighborhood = addr.neighbourhood || addr.suburb || addr.quarter;
        const city = addr.city || addr.town || addr.village || addr.county;
        const country = addr.country;

        if (neighborhood && city) {
            return `${neighborhood}, ${city}`;
        } else if (city) {
            return city;
        } else if (addr.road) {
            return addr.road;
        } else {
            return country || `${lat}, ${lng}`;
        }
    }

    // --- Open-Meteo API Fetcher ---
    async function fetchBatchAirQuality(queue) {
        if (queue.length === 0) return;

        // Group batch coordinates
        const latitudes = queue.map(q => q.lat).join(',');
        const longitudes = queue.map(q => q.lng).join(',');

        try {
            const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitudes}&longitude=${longitudes}&current=pm2_5&hourly=pm2_5&timezone=auto`;
            const response = await fetch(url);
            
            if (!response.ok) throw new Error('Open-Meteo Air Quality batch request failed');

            const results = await response.json();
            
            // If we queried a single coordinate, Open-Meteo returns a JSON object.
            // If multiple coordinates are queried, it returns a JSON array.
            const resultsArray = Array.isArray(results) ? results : [results];

            // Store in Cache
            const now = Date.now();
            resultsArray.forEach((item, index) => {
                const targetKey = queue[index].key;
                
                // Parse metrics
                const hourly = item.hourly;
                let worstPm25 = 0;
                let worstTimeIndex = 0;

                // Find the worst hour in the forecast (next 48h)
                if (hourly && hourly.pm2_5) {
                    // Open-Meteo returns a list of 120+ hours. We only scan the upcoming 48 hours.
                    const maxScanHours = Math.min(48, hourly.pm2_5.length);
                    for (let i = 0; i < maxScanHours; i++) {
                        if (hourly.pm2_5[i] > worstPm25) {
                            worstPm25 = hourly.pm2_5[i];
                            worstTimeIndex = i;
                        }
                    }
                }

                state.cache[targetKey] = {
                    timestamp: now,
                    data: {
                        current_pm2_5: item.current ? item.current.pm2_5 : (hourly ? hourly.pm2_5[0] : 0),
                        worst_pm2_5: worstPm25,
                        worst_time: hourly ? hourly.time[worstTimeIndex] : '--:--',
                        hourly_times: hourly ? hourly.time.slice(0, 48) : [],
                        hourly_pm25: hourly ? hourly.pm2_5.slice(0, 48) : []
                    }
                };
            });

            // Persist to LocalStorage
            try {
                localStorage.setItem('smokemap_aqi_cache', JSON.stringify(state.cache));
            } catch (e) {
                console.error('Failed to save cache to localStorage:', e);
            }

        } catch (e) {
            console.error('Error fetching air quality data:', e);
        }
    }

    // --- Cigarette Calculations & Color Scale ---
    function getCellColorStyle(data) {
        // Choose base PM2.5 value depending on mode
        const val = state.selectedMode === 'worst' ? data.worst_pm2_5 : data.current_pm2_5;
        const cigCount = val / BERKELEY_EARTH_PM25_FACTOR;

        // Colors mapping to custom styling values
        if (cigCount <= 0.5) {
            return { color: 'var(--color-clean)', opacity: 0.25 };
        } else if (cigCount <= 1.5) {
            return { color: 'var(--color-moderate)', opacity: 0.35 };
        } else if (cigCount <= 3.0) {
            return { color: 'var(--color-unhealthy-sens)', opacity: 0.45 };
        } else if (cigCount <= 5.0) {
            return { color: 'var(--color-unhealthy)', opacity: 0.55 };
        } else {
            return { color: 'var(--color-hazardous)', opacity: 0.65 };
        }
    }

    // --- Drawer UI Updater ---
    function updateDrawerUI(data, lat, lng) {
        // Set coordinates text
        document.getElementById('location-coords').textContent = `Coords: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;

        // Mode Metrics
        const currentCig = data.current_pm2_5 / BERKELEY_EARTH_PM25_FACTOR;
        const worstCig = data.worst_pm2_5 / BERKELEY_EARTH_PM25_FACTOR;

        // Choose primary metric based on mode selected
        const primaryCig = state.selectedMode === 'worst' ? worstCig : currentCig;
        const primaryPm25 = state.selectedMode === 'worst' ? data.worst_pm2_5 : data.current_pm2_5;

        // Set Main Cigarette Count
        document.getElementById('cig-count-value').textContent = primaryCig.toFixed(1);
        
        // Set Worst Cigarette Count
        document.getElementById('worst-cig-value').textContent = worstCig.toFixed(1);
        
        // Worst Hour Label Time format (ISO format is: 2026-07-14T20:00 -> 20:00)
        let timeLabel = '--:--';
        if (data.worst_time && data.worst_time !== '--:--') {
            try {
                const parts = data.worst_time.split('T');
                timeLabel = parts[1] || data.worst_time;
            } catch (err) {
                timeLabel = data.worst_time;
            }
        }
        document.getElementById('worst-time-label').textContent = timeLabel;

        // Configure AQI Badge Class & Text
        const badge = document.getElementById('drawer-aqi-badge');
        const badgeText = document.getElementById('aqi-text');
        
        badge.className = 'aqi-badge'; // reset
        if (primaryCig <= 0.5) {
            badge.classList.add('bg-clean');
            badgeText.textContent = 'Good';
        } else if (primaryCig <= 1.5) {
            badge.classList.add('bg-moderate');
            badgeText.textContent = 'Moderate';
        } else if (primaryCig <= 3.0) {
            badge.classList.add('bg-unhealthy-sens');
            badgeText.textContent = 'Unhealthy (Sens)';
        } else if (primaryCig <= 5.0) {
            badge.classList.add('bg-unhealthy');
            badgeText.textContent = 'Unhealthy';
        } else {
            badge.classList.add('bg-hazardous');
            badgeText.textContent = 'Hazardous';
        }

        // Cumulative Exposures Calculations
        const hour1 = primaryCig / 24;
        const week1 = primaryCig * 7;
        const month1 = primaryCig * 30;
        const year1 = primaryCig * 365;

        document.getElementById('time-1h').textContent = hour1 < 0.01 ? `${hour1.toFixed(3)} cig` : `${hour1.toFixed(2)} cig`;
        document.getElementById('time-1w').textContent = `${week1.toFixed(1)} cig`;
        document.getElementById('time-1m').textContent = `${month1.toFixed(1)} cig`;
        document.getElementById('time-1y').textContent = `${Math.round(year1)} cig`;

        // Interactive Equivalence Text
        const adviceContainer = document.getElementById('cigarette-equivalence-text');
        adviceContainer.textContent = getEquivalenceText(primaryCig, primaryPm25);

        // Render Dynamic Forecast Chart
        renderForecastSVGChart(data);
    }

    function getEquivalenceText(cigs, pm25) {
        if (cigs <= 0.5) {
            return `Breathable and safe. Breathing this air for 24 hours (PM2.5: ${Math.round(pm25)} μg/m³) is equivalent to smoking just ${cigs.toFixed(2)} cigarettes. No health precautions needed.`;
        } else if (cigs <= 1.5) {
            return `Moderate exposure. Breathing the air here for 24 hours is equivalent to smoking ${cigs.toFixed(1)} cigarettes. Active children and adults, and people with respiratory disease, should monitor for coughing or throat irritation.`;
        } else if (cigs <= 3.0) {
            return `Elevated exposure. 24 hours here equals smoking ${cigs.toFixed(1)} cigarettes. Equivalent to spending hours in a smoke-filled bar. Sensitive groups should reduce heavy outdoor exertion.`;
        } else if (cigs <= 5.0) {
            return `High exposure. 24 hours in this air is equivalent to smoking ${cigs.toFixed(1)} cigarettes. Equivalent to sitting next to an active smoker for a full day. Everyone should limit outdoor activities.`;
        } else {
            return `HAZARDOUS level. 24 hours of breathing this air equates to smoking ${cigs.toFixed(1)} cigarettes! Avoid all outdoor physical activity. Keep windows closed and run air filters.`;
        }
    }

    // --- Dynamic Inline SVG Chart Creator ---
    function renderForecastSVGChart(data) {
        const svg = document.getElementById('forecast-chart');
        svg.innerHTML = ''; // Clear previous

        if (!data.hourly_pm25 || data.hourly_pm25.length === 0) {
            svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--text-subtle)" font-size="12">No forecast available</text>`;
            return;
        }

        const hourlyCigs = data.hourly_pm25.map(pm => pm / BERKELEY_EARTH_PM25_FACTOR);
        const maxVal = Math.max(...hourlyCigs);
        const chartHeight = 110;
        const chartWidth = 500;
        const paddingY = 15;
        const bottomY = chartHeight + paddingY;

        // Prevent divide by zero if flat clean air
        const scaleMax = maxVal < 1.0 ? 1.0 : maxVal * 1.1;

        // Generate coordinates array
        const points = hourlyCigs.map((cig, index) => {
            const x = (index / (hourlyCigs.length - 1)) * chartWidth;
            // In SVG, Y coordinates go downwards, so invert
            const y = bottomY - (cig / scaleMax) * chartHeight;
            return { x, y, cig, time: data.hourly_times[index] };
        });

        // 1. Create a Linear Gradient for Area Fill
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.innerHTML = `
            <linearGradient id="chart-area-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.35"/>
                <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
            </linearGradient>
        `;
        svg.appendChild(defs);

        // 2. Add Horizontal Grid Guidelines
        const yGridTicks = [0, 0.5, 1.0]; // percentage lines
        yGridTicks.forEach(percent => {
            const y = bottomY - percent * chartHeight;
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', '0');
            line.setAttribute('y1', y.toString());
            line.setAttribute('x2', chartWidth.toString());
            line.setAttribute('y2', y.toString());
            line.setAttribute('stroke', 'rgba(255, 255, 255, 0.06)');
            line.setAttribute('stroke-dasharray', '4, 4');
            svg.appendChild(line);

            // Add value labels on the right
            const gridVal = percent * scaleMax;
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', (chartWidth - 5).toString());
            text.setAttribute('y', (y - 4).toString());
            text.setAttribute('fill', 'var(--text-subtle)');
            text.setAttribute('font-size', '8');
            text.setAttribute('text-anchor', 'end');
            text.textContent = `${gridVal.toFixed(1)} cig`;
            svg.appendChild(text);
        });

        // 3. Construct Path strings
        let linePathD = `M ${points[0].x} ${points[0].y}`;
        let areaPathD = `M ${points[0].x} ${bottomY} L ${points[0].x} ${points[0].y}`;

        for (let i = 1; i < points.length; i++) {
            linePathD += ` L ${points[i].x} ${points[i].y}`;
            areaPathD += ` L ${points[i].x} ${points[i].y}`;
        }
        
        areaPathD += ` L ${points[points.length - 1].x} ${bottomY} Z`;

        // 4. Append Area Fill Path
        const areaPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        areaPath.setAttribute('d', areaPathD);
        areaPath.setAttribute('fill', 'url(#chart-area-grad)');
        svg.appendChild(areaPath);

        // 5. Append Stroke Line Path
        const linePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        linePath.setAttribute('d', linePathD);
        linePath.setAttribute('fill', 'none');
        linePath.setAttribute('stroke', 'var(--primary)');
        linePath.setAttribute('stroke-width', '2.5');
        linePath.setAttribute('stroke-linecap', 'round');
        svg.appendChild(linePath);

        // 6. Highlight Current Hour (point index 0 or closest forecast hour)
        // Find Peak Index
        let peakIndex = 0;
        let peakVal = 0;
        points.forEach((pt, idx) => {
            if (pt.cig > peakVal) {
                peakVal = pt.cig;
                peakIndex = idx;
            }
        });

        // Draw Peak Highlight Dot
        if (peakVal > 0) {
            const peakPt = points[peakIndex];
            
            // Halo glow circle
            const glow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            glow.setAttribute('cx', peakPt.x.toString());
            glow.setAttribute('cy', peakPt.y.toString());
            glow.setAttribute('r', '7');
            glow.setAttribute('fill', 'var(--primary)');
            glow.setAttribute('opacity', '0.4');
            svg.appendChild(glow);

            // Core dot
            const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            dot.setAttribute('cx', peakPt.x.toString());
            dot.setAttribute('cy', peakPt.y.toString());
            dot.setAttribute('r', '3.5');
            dot.setAttribute('fill', '#ffffff');
            dot.setAttribute('stroke', 'var(--primary)');
            dot.setAttribute('stroke-width', '1.5');
            svg.appendChild(dot);

            // Text tag above peak
            const peakText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            peakText.setAttribute('x', peakPt.x.toString());
            peakText.setAttribute('y', (peakPt.y - 12).toString());
            peakText.setAttribute('fill', 'var(--text-main)');
            peakText.setAttribute('font-size', '9');
            peakText.setAttribute('font-weight', 'bold');
            peakText.setAttribute('text-anchor', 'middle');
            
            // Format hour
            let peakTimeText = 'Peak';
            try {
                const parts = peakPt.time.split('T');
                if (parts[1]) peakTimeText = parts[1];
            } catch (e) {}

            peakText.textContent = `Peak (${peakPt.cig.toFixed(1)} cig @ ${peakTimeText})`;
            svg.appendChild(peakText);
        }

        // Configure Chart Timeline Labels
        // Start Time Label
        try {
            const startParts = data.hourly_times[0].split('T');
            document.getElementById('chart-start-time').textContent = `Now (${startParts[1] || '00:00'})`;
        } catch (e) {}

        // End Time Label
        try {
            const endParts = data.hourly_times[data.hourly_times.length - 1].split('T');
            document.getElementById('chart-end-time').textContent = `+48h (${endParts[1] || '00:00'})`;
        } catch (e) {}
    }

    // --- Cache Management Helpers ---
    function isCacheValid(key) {
        const cachedItem = state.cache[key];
        if (!cachedItem) return false;
        return (Date.now() - cachedItem.timestamp) < state.cacheTTL;
    }

    function cleanExpiredCache() {
        const now = Date.now();
        Object.keys(state.cache).forEach(key => {
            if ((now - state.cache[key].timestamp) > state.cacheTTL) {
                delete state.cache[key];
            }
        });
    }

    // Initialize application logic
    init();
});
