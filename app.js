// SmokeMap - Application Logic

document.addEventListener('DOMContentLoaded', () => {
    // --- State Management ---
    const state = {
        map: null,
        selectedMode: 'worst', // 'worst' or 'current'
        selectedStyle: 'dark', // 'dark' or 'light'
        calculationBase: 'pm25', // 'pm25' or 'aqi'
        selectedCell: null,    // { bounds: L.LatLngBounds, data: Object, latCenter: Number, lngCenter: Number }
        gridCells: {},         // Key: 'lat_lng', Value: { rectangle: L.Rectangle, data: Object }
        cache: {},             // Key: 'lat_lng', Value: { timestamp: Number, data: Object }
        cacheTTL: 60 * 60 * 1000, // 1 hour in milliseconds
        searchTimeout: null,
        debouncedFetchTimeout: null,
        currentHighlight: null, // Highlighted selected cell rectangle
        userCoords: null,       // User's physical location
        rateLimitModalActive: false // Track if rate limit warning modal is active
    };

    // --- Configuration Constants ---
    const BERKELEY_EARTH_PM25_FACTOR = 22; // 22 ug/m3 PM2.5 = 1 cigarette per day

    // Convert US AQI back to PM2.5 concentration using the EPA 2024 breakpoints
    function getPm25FromAqi(aqi) {
        if (aqi <= 0) return 0;
        
        let bpLo, bpHi, iLo, iHi;
        
        if (aqi <= 50) {
            bpLo = 0.0; bpHi = 9.0;
            iLo = 0; iHi = 50;
        } else if (aqi <= 100) {
            bpLo = 9.1; bpHi = 35.4;
            iLo = 51; iHi = 100;
        } else if (aqi <= 150) {
            bpLo = 35.5; bpHi = 55.4;
            iLo = 101; iHi = 150;
        } else if (aqi <= 200) {
            bpLo = 55.5; bpHi = 125.4;
            iLo = 151; iHi = 200;
        } else if (aqi <= 300) {
            bpLo = 125.5; bpHi = 225.4;
            iLo = 201; iHi = 300;
        } else if (aqi <= 400) {
            bpLo = 225.5; bpHi = 325.4;
            iLo = 301; iHi = 400;
        } else {
            bpLo = 325.5; bpHi = 999.9;
            iLo = 401; iHi = 500;
        }
        
        return ((aqi - iLo) * (bpHi - bpLo)) / (iHi - iLo) + bpLo;
    }

    // Determine the AQI level category and color class
    function getAqiCategory(aqi) {
        if (aqi <= 50) return { class: 'bg-clean', label: 'Good' };
        if (aqi <= 100) return { class: 'bg-moderate', label: 'Moderate' };
        if (aqi <= 150) return { class: 'bg-unhealthy-sens', label: 'Unhealthy (Sens)' };
        if (aqi <= 200) return { class: 'bg-unhealthy', label: 'Unhealthy' };
        return { class: 'bg-hazardous', label: 'Hazardous' };
    }

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
            const savedCache = localStorage.getItem('smokemap_aqi_cache_v2');
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
        // Toggle Overlay Mode: Worst vs Current vs Annual vs Worst Day
        document.getElementById('mode-worst').addEventListener('click', (e) => {
            switchMode('worst');
        });
        document.getElementById('mode-current').addEventListener('click', (e) => {
            switchMode('current');
        });
        document.getElementById('mode-annual').addEventListener('click', (e) => {
            switchMode('annual');
        });
        document.getElementById('mode-worst-day').addEventListener('click', (e) => {
            switchMode('worst_day');
        });

        // Toggle Calculation Base: PM2.5 Only vs All Pollutants (AQI)
        document.getElementById('calc-pm25').addEventListener('click', () => {
            switchCalculationBase('pm25');
        });
        document.getElementById('calc-aqi').addEventListener('click', () => {
            switchCalculationBase('aqi');
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

        // Rate Limit Modal Setup
        const rateLimitModal = document.getElementById('rate-limit-modal');
        const closeRateLimitBtn = document.getElementById('close-rate-limit-modal');
        const dismissRateLimitBtn = document.getElementById('dismiss-rate-limit-btn');
        
        const closeRateLimit = () => {
            if (rateLimitModal) {
                rateLimitModal.close();
            }
            state.rateLimitModalActive = false;
        };

        if (closeRateLimitBtn) {
            closeRateLimitBtn.addEventListener('click', closeRateLimit);
        }
        if (dismissRateLimitBtn) {
            dismissRateLimitBtn.addEventListener('click', closeRateLimit);
        }
        if (rateLimitModal) {
            rateLimitModal.addEventListener('click', (e) => {
                if (e.target === rateLimitModal) {
                    closeRateLimit();
                }
            });
        }

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
        document.getElementById('mode-annual').classList.toggle('active', mode === 'annual');
        document.getElementById('mode-worst-day').classList.toggle('active', mode === 'worst_day');
        
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

        // Trigger grid update in case viewport cells need historical data loaded
        updateGrid();
    }

    // --- Calculation Base Toggle ---
    function switchCalculationBase(base) {
        if (state.calculationBase === base) return;
        state.calculationBase = base;
        
        document.getElementById('calc-pm25').classList.toggle('active', base === 'pm25');
        document.getElementById('calc-aqi').classList.toggle('active', base === 'aqi');
        
        // Update the legend caption dynamically
        const legendCaption = document.getElementById('legend-caption');
        if (legendCaption) {
            if (base === 'aqi') {
                legendCaption.innerHTML = 'Cigarettes derived from overall US AQI';
            } else {
                legendCaption.innerHTML = '1 cigarette ≈ 22 μg/m³ PM2.5 (Berkeley Earth)';
            }
        }

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
            const data = state.selectedCell.data;
            const needsHistory = state.calculationBase === 'aqi' 
                ? (data.annual_avg_us_aqi === undefined) 
                : (data.annual_avg_pm2_5 === undefined);

            if (needsHistory) {
                setHistoricalLoadingState();
                fetchBatchHistoricalAirQuality([{ 
                    key: state.selectedCell.key, 
                    lat: state.selectedCell.latCenter, 
                    lng: state.selectedCell.lngCenter 
                }]).then(() => {
                    const updatedCached = state.cache[state.selectedCell.key];
                    if (updatedCached && state.selectedCell && state.selectedCell.key === state.selectedCell.key) {
                        state.selectedCell.data = updatedCached.data;
                        updateDrawerUI(updatedCached.data, state.selectedCell.latCenter, state.selectedCell.lngCenter);
                    }
                }).catch(err => {
                    console.error('Failed to load historical data on base switch:', err);
                    setHistoricalErrorState();
                });
            } else {
                updateDrawerUI(state.selectedCell.data, state.selectedCell.latCenter, state.selectedCell.lngCenter);
            }
        }

        // Trigger grid update in case viewport cells need new cache variables loaded
        updateGrid();
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
            
            if (response.status === 429) {
                showRateLimitModal();
            }
            if (!response.ok) throw new Error('Nominatim request failed');
            
            const results = await response.json();
            displaySearchResults(results);
        } catch (e) {
            console.error('Error fetching geocoding suggestions:', e);
            if (navigator.onLine) {
                showRateLimitModal();
            }
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

        // 2. If historical data is not cached, fetch it in background
        const needsHistory = state.calculationBase === 'aqi'
            ? (data.annual_avg_us_aqi === undefined)
            : (data.annual_avg_pm2_5 === undefined);

        if (needsHistory) {
            setHistoricalLoadingState();
            try {
                await fetchBatchHistoricalAirQuality([{ key, lat: latCenter, lng: lngCenter }]);
                const updatedCached = state.cache[key];
                if (updatedCached && state.selectedCell && state.selectedCell.key === key) {
                    state.selectedCell.data = updatedCached.data;
                    updateDrawerUI(updatedCached.data, latCenter, lngCenter);
                }
            } catch (err) {
                console.error('Failed to load historical data for selected cell:', err);
                setHistoricalErrorState();
            }
        }

        // 3. Perform background geocoding request to find name of clicked place
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
        try {
            const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14`, {
                headers: {
                    'User-Agent': 'SmokeMap/1.0 (Web Air Quality overlay project)'
                }
            });
            
            if (response.status === 429) {
                showRateLimitModal();
            }
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
    } catch (e) {
        if (navigator.onLine) {
            showRateLimitModal();
        }
        throw e;
    }
}

    // --- Open-Meteo API Fetcher ---
    async function fetchBatchAirQuality(queue) {
        if (queue.length === 0) return;

        const latitudes = queue.map(q => q.lat).join(',');
        const longitudes = queue.map(q => q.lng).join(',');
        const now = Date.now();

        const needHistory = (state.selectedMode === 'annual' || state.selectedMode === 'worst_day');
        const promises = [];

        // 1. Fetch Forecast
        const fetchForecast = async () => {
            try {
                const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitudes}&longitude=${longitudes}&current=us_aqi,pm2_5,pm10,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,us_aqi_pm2_5,us_aqi_pm10,us_aqi_ozone,us_aqi_nitrogen_dioxide,us_aqi_sulphur_dioxide,us_aqi_carbon_monoxide&hourly=us_aqi,pm2_5,pm10,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,us_aqi_pm2_5,us_aqi_pm10,us_aqi_ozone,us_aqi_nitrogen_dioxide,us_aqi_sulphur_dioxide,us_aqi_carbon_monoxide&timezone=auto`;
                const response = await fetch(url);
                if (response.status === 429) {
                    showRateLimitModal();
                }
                if (!response.ok) throw new Error('Open-Meteo Air Quality batch request failed');
                
                const results = await response.json();
                const resultsArray = Array.isArray(results) ? results : [results];

                resultsArray.forEach((item, index) => {
                    const targetKey = queue[index].key;
                    const hourly = item.hourly;
                    
                    let worstPm25 = 0;
                    let worstPm25TimeIndex = 0;
                    let worstAqi = 0;
                    let worstAqiTimeIndex = 0;

                    if (hourly) {
                        const maxScanHours = Math.min(48, hourly.time.length);
                        if (hourly.pm2_5) {
                            for (let i = 0; i < maxScanHours; i++) {
                                if (hourly.pm2_5[i] > worstPm25) {
                                    worstPm25 = hourly.pm2_5[i];
                                    worstPm25TimeIndex = i;
                                }
                            }
                        }
                        if (hourly.us_aqi) {
                            for (let i = 0; i < maxScanHours; i++) {
                                if (hourly.us_aqi[i] > worstAqi) {
                                    worstAqi = hourly.us_aqi[i];
                                    worstAqiTimeIndex = i;
                                }
                            }
                        }
                    }

                    const currentVal = (prop) => {
                        if (item.current && item.current[prop] !== undefined) {
                            return item.current[prop];
                        }
                        if (hourly && hourly[prop] && hourly[prop].length > 0) {
                            return hourly[prop][0];
                        }
                        return 0;
                    };

                    const existingData = state.cache[targetKey] ? state.cache[targetKey].data : {};
                    state.cache[targetKey] = {
                        timestamp: now,
                        data: {
                            ...existingData,
                            current_pm2_5: currentVal('pm2_5'),
                            current_us_aqi: currentVal('us_aqi'),
                            
                            // Other current pollutants
                            current_pm10: currentVal('pm10'),
                            current_carbon_monoxide: currentVal('carbon_monoxide'),
                            current_nitrogen_dioxide: currentVal('nitrogen_dioxide'),
                            current_sulphur_dioxide: currentVal('sulphur_dioxide'),
                            current_ozone: currentVal('ozone'),
                            
                            // Other current pollutant AQIs
                            current_aqi_pm2_5: currentVal('us_aqi_pm2_5'),
                            current_aqi_pm10: currentVal('us_aqi_pm10'),
                            current_aqi_carbon_monoxide: currentVal('us_aqi_carbon_monoxide'),
                            current_aqi_nitrogen_dioxide: currentVal('us_aqi_nitrogen_dioxide'),
                            current_aqi_sulphur_dioxide: currentVal('us_aqi_sulphur_dioxide'),
                            current_aqi_ozone: currentVal('us_aqi_ozone'),

                            worst_pm2_5: worstPm25,
                            worst_pm25_time: hourly ? hourly.time[worstPm25TimeIndex] : '--:--',
                            worst_us_aqi: worstAqi,
                            worst_aqi_time: hourly ? hourly.time[worstAqiTimeIndex] : '--:--',
                            
                            hourly_times: hourly ? hourly.time.slice(0, 48) : [],
                            hourly_pm25: hourly ? hourly.pm2_5.slice(0, 48) : [],
                            hourly_us_aqi: hourly ? hourly.us_aqi.slice(0, 48) : []
                        }
                    };
                });
            } catch (e) {
                console.error('Error fetching air quality forecast:', e);
                if (navigator.onLine) {
                    showRateLimitModal();
                }
            }
        };
        promises.push(fetchForecast());

        // 2. Fetch History in Parallel if needed
        if (needHistory) {
            promises.push(fetchBatchHistoricalAirQuality(queue));
        }

        await Promise.all(promises);

        // Persist to LocalStorage
        try {
            localStorage.setItem('smokemap_aqi_cache_v2', JSON.stringify(state.cache));
        } catch (e) {
            console.error('Failed to save cache to localStorage:', e);
        }
    }

    async function fetchBatchHistoricalAirQuality(queue) {
        if (queue.length === 0) return;

        const latitudes = queue.map(q => q.lat).join(',');
        const longitudes = queue.map(q => q.lng).join(',');

        try {
            const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitudes}&longitude=${longitudes}&start_date=2025-01-01&end_date=2025-12-31&hourly=pm2_5,us_aqi&timezone=auto`;
            const response = await fetch(url);
            if (response.status === 429) {
                showRateLimitModal();
            }
            if (!response.ok) throw new Error('Open-Meteo Air Quality historical batch request failed');

            const results = await response.json();
            const resultsArray = Array.isArray(results) ? results : [results];

            resultsArray.forEach((item, index) => {
                const targetKey = queue[index].key;
                const hourly = item.hourly;

                // Ensure cache entry structure exists
                if (!state.cache[targetKey]) {
                    state.cache[targetKey] = { timestamp: Date.now(), data: {} };
                }

                if (hourly && hourly.pm2_5) {
                    const validPm25 = hourly.pm2_5.filter(val => val !== null && val !== undefined);
                    const annualAvg = validPm25.length > 0 ? (validPm25.reduce((a, b) => a + b, 0) / validPm25.length) : 0;

                    // Group by date to find the worst day
                    const dailyValues = {};
                    for (let i = 0; i < hourly.time.length; i++) {
                        const timeStr = hourly.time[i];
                        const val = hourly.pm2_5[i];
                        if (val === null || val === undefined) continue;
                        const dateStr = timeStr.substring(0, 10);
                        if (!dailyValues[dateStr]) {
                            dailyValues[dateStr] = [];
                        }
                        dailyValues[dateStr].push(val);
                    }

                    let worstDayDate = '--';
                    let worstDayPm25 = 0;
                    Object.keys(dailyValues).forEach(dateStr => {
                        const vals = dailyValues[dateStr];
                        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
                        if (avg > worstDayPm25) {
                            worstDayPm25 = avg;
                            worstDayDate = dateStr;
                        }
                    });

                    state.cache[targetKey].data.annual_avg_pm2_5 = annualAvg;
                    state.cache[targetKey].data.worst_day_pm2_5 = worstDayPm25;
                    state.cache[targetKey].data.worst_day_date = worstDayDate;
                }

                if (hourly && hourly.us_aqi) {
                    const validAqi = hourly.us_aqi.filter(val => val !== null && val !== undefined);
                    const annualAvgAqi = validAqi.length > 0 ? (validAqi.reduce((a, b) => a + b, 0) / validAqi.length) : 0;

                    // Group by date to find the worst day
                    const dailyAqiValues = {};
                    for (let i = 0; i < hourly.time.length; i++) {
                        const timeStr = hourly.time[i];
                        const val = hourly.us_aqi[i];
                        if (val === null || val === undefined) continue;
                        const dateStr = timeStr.substring(0, 10);
                        if (!dailyAqiValues[dateStr]) {
                            dailyAqiValues[dateStr] = [];
                        }
                        dailyAqiValues[dateStr].push(val);
                    }

                    let worstDayAqiDate = '--';
                    let worstDayAqi = 0;
                    Object.keys(dailyAqiValues).forEach(dateStr => {
                        const vals = dailyAqiValues[dateStr];
                        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
                        if (avg > worstDayAqi) {
                            worstDayAqi = avg;
                            worstDayAqiDate = dateStr;
                        }
                    });

                    state.cache[targetKey].data.annual_avg_us_aqi = annualAvgAqi;
                    state.cache[targetKey].data.worst_day_us_aqi = worstDayAqi;
                    state.cache[targetKey].data.worst_day_aqi_date = worstDayAqiDate;
                }
            });
        } catch (e) {
            console.error('Error fetching historical air quality data:', e);
            if (navigator.onLine) {
                showRateLimitModal();
            }
        }
    }

    function setHistoricalLoadingState() {
        const histAnnualAvgVal = document.getElementById('hist-annual-avg');
        const histAnnualPmVal = document.getElementById('hist-annual-pm');
        const histWorstDayVal = document.getElementById('hist-worst-day');
        const histWorstDayDate = document.getElementById('hist-worst-day-date');
        
        if (histAnnualAvgVal) histAnnualAvgVal.textContent = 'Loading...';
        if (histAnnualPmVal) histAnnualPmVal.textContent = 'Fetching data...';
        if (histWorstDayVal) histWorstDayVal.textContent = 'Loading...';
        if (histWorstDayDate) histWorstDayDate.textContent = 'Please wait...';
    }

    function setHistoricalErrorState() {
        const histAnnualAvgVal = document.getElementById('hist-annual-avg');
        const histAnnualPmVal = document.getElementById('hist-annual-pm');
        const histWorstDayVal = document.getElementById('hist-worst-day');
        const histWorstDayDate = document.getElementById('hist-worst-day-date');
        
        if (histAnnualAvgVal) histAnnualAvgVal.textContent = 'Error';
        if (histAnnualPmVal) histAnnualPmVal.textContent = 'Failed to load';
        if (histWorstDayVal) histWorstDayVal.textContent = 'Error';
        if (histWorstDayDate) histWorstDayDate.textContent = 'Retry later';
    }

    // --- Cigarette Calculations & Color Scale ---
    function getCellColorStyle(data) {
        let val;
        let aqi;

        if (state.selectedMode === 'worst') {
            val = data.worst_pm2_5;
            aqi = data.worst_us_aqi !== undefined ? data.worst_us_aqi : 0;
        } else if (state.selectedMode === 'current') {
            val = data.current_pm2_5;
            aqi = data.current_us_aqi !== undefined ? data.current_us_aqi : 0;
        } else if (state.selectedMode === 'annual') {
            val = data.annual_avg_pm2_5 !== undefined ? data.annual_avg_pm2_5 : 0;
            aqi = data.annual_avg_us_aqi !== undefined ? data.annual_avg_us_aqi : 0;
        } else if (state.selectedMode === 'worst_day') {
            val = data.worst_day_pm2_5 !== undefined ? data.worst_day_pm2_5 : 0;
            aqi = data.worst_day_us_aqi !== undefined ? data.worst_day_us_aqi : 0;
        } else {
            val = data.current_pm2_5;
            aqi = data.current_us_aqi !== undefined ? data.current_us_aqi : 0;
        }
        
        let cigCount;
        if (state.calculationBase === 'aqi') {
            const eqPm25 = getPm25FromAqi(aqi);
            cigCount = eqPm25 / BERKELEY_EARTH_PM25_FACTOR;
        } else {
            cigCount = val / BERKELEY_EARTH_PM25_FACTOR;
        }

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

        // Helper to get cigarette count based on current calculation base
        const getCigValue = (pm25Val, aqiVal) => {
            if (state.calculationBase === 'aqi') {
                const eqPm = getPm25FromAqi(aqiVal !== undefined ? aqiVal : 0);
                return eqPm / BERKELEY_EARTH_PM25_FACTOR;
            } else {
                return pm25Val / BERKELEY_EARTH_PM25_FACTOR;
            }
        };

        const currentCig = getCigValue(data.current_pm2_5, data.current_us_aqi);
        const worstCig = getCigValue(data.worst_pm2_5, data.worst_us_aqi);

        // Choose primary metric and description based on mode selected
        let primaryCig, primaryPm25, modeDescription;
        if (state.selectedMode === 'worst') {
            primaryPm25 = state.calculationBase === 'aqi' ? getPm25FromAqi(data.worst_us_aqi || 0) : data.worst_pm2_5;
            primaryCig = worstCig;
            modeDescription = 'equivalent inhaled at worst forecasted hour';
        } else if (state.selectedMode === 'current') {
            primaryPm25 = state.calculationBase === 'aqi' ? getPm25FromAqi(data.current_us_aqi || 0) : data.current_pm2_5;
            primaryCig = currentCig;
            modeDescription = 'equivalent inhaled per 24 hours (current)';
        } else if (state.selectedMode === 'annual') {
            const annualPm = data.annual_avg_pm2_5 !== undefined ? data.annual_avg_pm2_5 : 0;
            const annualAqi = data.annual_avg_us_aqi !== undefined ? data.annual_avg_us_aqi : 0;
            primaryPm25 = state.calculationBase === 'aqi' ? getPm25FromAqi(annualAqi) : annualPm;
            primaryCig = getCigValue(annualPm, annualAqi);
            modeDescription = 'equivalent inhaled per 24 hours (2025 average)';
        } else if (state.selectedMode === 'worst_day') {
            const worstDayPm = data.worst_day_pm2_5 !== undefined ? data.worst_day_pm2_5 : 0;
            const worstDayAqi = data.worst_day_us_aqi !== undefined ? data.worst_day_us_aqi : 0;
            primaryPm25 = state.calculationBase === 'aqi' ? getPm25FromAqi(worstDayAqi) : worstDayPm;
            primaryCig = getCigValue(worstDayPm, worstDayAqi);
            
            let formattedDate = '';
            const activeWorstDate = state.calculationBase === 'aqi' ? data.worst_day_aqi_date : data.worst_day_date;
            if (activeWorstDate) {
                try {
                    const dateObj = new Date(activeWorstDate);
                    formattedDate = dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
                } catch (e) {
                    formattedDate = activeWorstDate;
                }
            }
            modeDescription = `inhaled on worst day of 2025 (${formattedDate || 'date N/A'})`;
        }

        // Set Main Cigarette Count
        document.getElementById('cig-count-value').textContent = primaryCig.toFixed(1);
        
        // Update Description Label
        const descLabel = document.getElementById('stat-description-label');
        if (descLabel) descLabel.textContent = modeDescription;
        
        // Set Worst Cigarette Count
        document.getElementById('worst-cig-value').textContent = worstCig.toFixed(1);
        
        // Worst Hour Label Time format (ISO format is: 2026-07-14T20:00 -> 20:00)
        let timeLabel = '--:--';
        const activeWorstTime = state.calculationBase === 'aqi' ? data.worst_aqi_time : data.worst_time;
        if (activeWorstTime && activeWorstTime !== '--:--') {
            try {
                const parts = activeWorstTime.split('T');
                timeLabel = parts[1] || activeWorstTime;
            } catch (err) {
                timeLabel = activeWorstTime;
            }
        }
        document.getElementById('worst-time-label').textContent = timeLabel;

        // Configure AQI Badge Class & Text
        const badge = document.getElementById('drawer-aqi-badge');
        const badgeText = document.getElementById('aqi-text');
        
        badge.className = 'aqi-badge'; // reset

        let aqiVal;
        if (state.selectedMode === 'worst') aqiVal = data.worst_us_aqi;
        else if (state.selectedMode === 'current') aqiVal = data.current_us_aqi;
        else if (state.selectedMode === 'annual') aqiVal = data.annual_avg_us_aqi;
        else if (state.selectedMode === 'worst_day') aqiVal = data.worst_day_us_aqi;

        if (state.calculationBase === 'aqi' && aqiVal !== undefined) {
            const cat = getAqiCategory(aqiVal);
            badge.classList.add(cat.class);
            badgeText.textContent = `${cat.label} (AQI ${Math.round(aqiVal)})`;
        } else {
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

        // Update Historical Section cards in drawer
        const histAnnualAvgVal = document.getElementById('hist-annual-avg');
        const histAnnualPmVal = document.getElementById('hist-annual-pm');
        const histWorstDayVal = document.getElementById('hist-worst-day');
        const histWorstDayDate = document.getElementById('hist-worst-day-date');

        if (histAnnualAvgVal && histAnnualPmVal && histWorstDayVal && histWorstDayDate) {
            const annualPm = data.annual_avg_pm2_5 !== undefined ? data.annual_avg_pm2_5 : 0;
            const annualAqi = data.annual_avg_us_aqi !== undefined ? data.annual_avg_us_aqi : 0;
            const worstDayPm = data.worst_day_pm2_5 !== undefined ? data.worst_day_pm2_5 : 0;
            const worstDayAqi = data.worst_day_us_aqi !== undefined ? data.worst_day_us_aqi : 0;

            if (data.annual_avg_pm2_5 !== undefined) {
                const annualCig = getCigValue(annualPm, annualAqi);
                histAnnualAvgVal.textContent = `${annualCig.toFixed(1)} cig`;
                
                if (state.calculationBase === 'aqi') {
                    histAnnualPmVal.textContent = `Avg AQI: ${Math.round(annualAqi)}`;
                } else {
                    histAnnualPmVal.textContent = `${Math.round(annualPm)} μg/m³ PM2.5`;
                }
                
                const worstDayCig = getCigValue(worstDayPm, worstDayAqi);
                histWorstDayVal.textContent = `${worstDayCig.toFixed(1)} cig`;
                
                let formattedWorstDate = '--';
                const activeWorstDate = state.calculationBase === 'aqi' ? data.worst_day_aqi_date : data.worst_day_date;
                if (activeWorstDate) {
                    try {
                        const dateObj = new Date(activeWorstDate);
                        formattedWorstDate = dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
                    } catch (e) {
                        formattedWorstDate = activeWorstDate;
                    }
                }
                histWorstDayDate.textContent = `on ${formattedWorstDate}`;
            } else {
                histAnnualAvgVal.textContent = 'Loading...';
                histAnnualPmVal.textContent = '--';
                histWorstDayVal.textContent = 'Loading...';
                histWorstDayDate.textContent = '--';
            }
        }

        // Render Pollutants Breakdown Grid
        renderPollutantBreakdown(data);

        // Render Dynamic Forecast Chart
        renderForecastSVGChart(data);
    }

    // --- Render Pollutant Breakdown Grid Helper ---
    function renderPollutantBreakdown(data) {
        const grid = document.getElementById('pollutant-breakdown-grid');
        if (!grid) return;
        grid.innerHTML = '';

        // If we don't have the new pollutant metrics, show a fallback message
        if (data.current_pm10 === undefined) {
            grid.innerHTML = `<div style="grid-column: span 2; text-align: center; padding: 12px; color: var(--text-subtle); font-size: 0.85rem;">Pollutant breakdown details not cached. Click map to reload.</div>`;
            return;
        }

        const pollutants = [
            {
                formula: 'PM<sub>2.5</sub>',
                name: 'Fine Particles',
                val: data.current_pm2_5,
                unit: 'μg/m³',
                aqi: data.current_aqi_pm2_5
            },
            {
                formula: 'PM<sub>10</sub>',
                name: 'Coarse Particles',
                val: data.current_pm10,
                unit: 'μg/m³',
                aqi: data.current_aqi_pm10
            },
            {
                formula: 'O<sub>3</sub>',
                name: 'Ozone',
                val: data.current_ozone,
                unit: 'μg/m³',
                aqi: data.current_aqi_ozone
            },
            {
                formula: 'CO',
                name: 'Carbon Monoxide',
                val: data.current_carbon_monoxide,
                unit: 'μg/m³',
                aqi: data.current_aqi_carbon_monoxide
            },
            {
                formula: 'NO<sub>2</sub>',
                name: 'Nitrogen Dioxide',
                val: data.current_nitrogen_dioxide,
                unit: 'μg/m³',
                aqi: data.current_aqi_nitrogen_dioxide
            },
            {
                formula: 'SO<sub>2</sub>',
                name: 'Sulphur Dioxide',
                val: data.current_sulphur_dioxide,
                unit: 'μg/m³',
                aqi: data.current_aqi_sulphur_dioxide
            }
        ];

        // Find dominant pollutant (highest AQI value)
        let dominantIndex = -1;
        let maxAqi = -1;
        pollutants.forEach((p, idx) => {
            if (p.aqi !== undefined && p.aqi > maxAqi) {
                maxAqi = p.aqi;
                dominantIndex = idx;
            }
        });

        pollutants.forEach((p, idx) => {
            if (p.val === undefined || p.val === null) return;

            const card = document.createElement('div');
            card.className = 'pollutant-card';
            
            const isDominant = idx === dominantIndex && maxAqi > 0;
            if (isDominant) {
                card.classList.add('dominant');
            }

            const cat = getAqiCategory(p.aqi || 0);
            
            let displayVal = p.val;
            let displayUnit = p.unit;
            if (p.formula === 'CO') {
                if (p.val > 100) {
                    displayVal = (p.val / 1000).toFixed(2);
                    displayUnit = 'mg/m³';
                } else {
                    displayVal = Math.round(p.val);
                    displayUnit = 'μg/m³';
                }
            } else {
                displayVal = Math.round(p.val);
            }

            card.innerHTML = `
                <div class="pollutant-header">
                    <span class="pollutant-formula">${p.formula}</span>
                    <span class="pollutant-name">${p.name}</span>
                    ${isDominant ? '<span class="dominant-label">Dominant</span>' : ''}
                </div>
                <div class="pollutant-value-row">
                    <span class="pollutant-concentration">${displayVal} <span style="font-size:0.75rem; font-weight:500; color:var(--text-muted)">${displayUnit}</span></span>
                    <span class="pollutant-aqi-badge ${cat.class}">AQI ${Math.round(p.aqi || 0)}</span>
                </div>
                <div class="pollutant-bar-bg">
                    <div class="pollutant-bar-fill" style="width: ${Math.min(100, ((p.aqi || 0) / 300) * 100)}%; background-color: var(--${cat.class.replace('bg-', 'color-')})"></div>
                </div>
            `;
            grid.appendChild(card);
        });
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

        const isAqi = state.calculationBase === 'aqi';
        const hasAqiData = data.hourly_us_aqi && data.hourly_us_aqi.length > 0;
        const hasPmData = data.hourly_pm25 && data.hourly_pm25.length > 0;

        if ((isAqi && !hasAqiData) || (!isAqi && !hasPmData)) {
            svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--text-subtle)" font-size="12">No forecast available</text>`;
            return;
        }

        let hourlyCigs;
        if (isAqi) {
            hourlyCigs = data.hourly_us_aqi.map(aqi => getPm25FromAqi(aqi) / BERKELEY_EARTH_PM25_FACTOR);
        } else {
            hourlyCigs = data.hourly_pm25.map(pm => pm / BERKELEY_EARTH_PM25_FACTOR);
        }

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
        
        const isForecastValid = (Date.now() - cachedItem.timestamp) < state.cacheTTL;
        
        // If in AQI mode, we require the AQI forecast variables to be present in cached data
        if (state.calculationBase === 'aqi') {
            const hasAqiForecast = cachedItem.data.current_us_aqi !== undefined && cachedItem.data.worst_us_aqi !== undefined;
            if (!hasAqiForecast) return false;
        }
        
        // If in historical mode, we require the historical data corresponding to the selected calculation base
        if (state.selectedMode === 'annual' || state.selectedMode === 'worst_day') {
            if (state.calculationBase === 'aqi') {
                const hasAqiHistory = cachedItem.data.annual_avg_us_aqi !== undefined && cachedItem.data.worst_day_us_aqi !== undefined;
                return isForecastValid && hasAqiHistory;
            } else {
                const hasPmHistory = cachedItem.data.annual_avg_pm2_5 !== undefined && cachedItem.data.worst_day_pm2_5 !== undefined;
                return isForecastValid && hasPmHistory;
            }
        }
        
        return isForecastValid;
    }

    function cleanExpiredCache() {
        const now = Date.now();
        Object.keys(state.cache).forEach(key => {
            if ((now - state.cache[key].timestamp) > state.cacheTTL) {
                delete state.cache[key];
            }
        });
    }

    function showRateLimitModal() {
        if (state.rateLimitModalActive) return;
        state.rateLimitModalActive = true;
        
        const rateLimitModal = document.getElementById('rate-limit-modal');
        if (rateLimitModal) {
            // Initialize Lucide icons on the modal element in case they haven't been processed
            if (window.lucide) {
                window.lucide.createIcons();
            }
            rateLimitModal.showModal();
        }
    }

    // Initialize application logic
    init();
});
