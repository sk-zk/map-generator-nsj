const TILE_SIZE = 256;
const MAX_TILES = 5;
const TILE_CACHE = {};
const LAYERS = {
	thin: (x,y,z) => `https://maps.googleapis.com/maps/vt?pb=!1m7!8m6!1m3!1i${z}!2i${x}!3i${y}!2i9!3x1!2m8!1e2!2ssvv!4m2!1scc!2s*211m3*211e2*212b1*213e2*212b1*214b1!4m2!1ssvl!2s*211b0*212b1!3m8!2sen!3sus!5e1105!12m4!1e68!2m2!1sset!2sRoadmap!4e0!5m4!1e0!8m2!1e1!1e1!6m6!1e12!2i2!11e0!39b0!44e0!50e`,
	fat: (x,y,z) => `https://mts1.googleapis.com/vt?hl=en-US&lyrs=svv|cb_client:app&style=5,8&x=${x}&y=${y}&z=${z}`,
}

const toRad = (n) => n * Math.PI / 180;
const toDeg = (n) => n * 180 / Math.PI;

function tileCacheKey(x, y, zoom, layer) {
	return `${layer}-${x}-${y}-${zoom}`;
}

async function loadTile(x, y, zoom, layer) {
	return new Promise((resolve, reject) => {
		const tileSpan = 1 << zoom;
		x %= tileSpan;
		y %= tileSpan;

		const key = tileCacheKey(x, y, zoom, layer);

		if(TILE_CACHE[key]) return resolve({x, y, zoom, img: TILE_CACHE[key]});

		const img = document.createElement('img');
		img.crossOrigin = 'anonymous';

		img.addEventListener('load', () => {
			TILE_CACHE[key] = img;
			return resolve({x, y, zoom, img});
		});

		img.addEventListener('error', reject);

		img.src = LAYERS[layer](x, y, zoom);
	});
}

function latLngToWorld(lat, lng) {
	let siny = Math.sin((lat * Math.PI) / 180);
	siny = Math.min(Math.max(siny, -0.9999), 0.9999);

	return {
		x: TILE_SIZE * (0.5 + lng / 360),
		y: TILE_SIZE * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI))
	}
}

function latLngToPixel(lat, lng, zoom) {
	const worldCoord = latLngToWorld(lat, lng);
	const formula = (n) => Math.floor(n * (1 << zoom));
	return {
		x: formula(worldCoord.x),
		y: formula(worldCoord.y),
	}
}

function latLngToTile(lat, lng, zoom) {
	const pixelCoord = latLngToPixel(lat, lng, zoom);
	const formula = (n) => Math.floor(n / TILE_SIZE);
	return {
		x: formula(pixelCoord.x),
		y: formula(pixelCoord.y),
	}
}

function latLngToCanvas(boundNW, tileNW, lat, lng, zoom) {
	const pixelCoord = latLngToPixel(lat, lng, zoom);
	const tileCoord = latLngToTile(lat, lng, zoom);
	const px = pixelCoord.x % TILE_SIZE;
	const py = pixelCoord.y % TILE_SIZE;

	return {
		x: (tileCoord.x - tileNW.x) * TILE_SIZE + px,
		y: (tileCoord.y - tileNW.y) * TILE_SIZE + py,
	}
}

function didOverlapCoverage(imageData, x, y, dx, dy) {
	for(let py = y-dy; py <= y+dy; py++) {
		for(let px = x-dx; px <= x+dx; px++) {
			const i = (py * imageData.width + px) * 4;
			if(i < 0 || i >= imageData.data.length) continue;
			if(imageData.data[i+3] > 0) return true;
		}
	}
	return false;
}

function calculateZoom(boundNW, boundSE, limit) {
	let zoom = 16;
	let tileCoordNW, tileCoordSE, cols, rows;

	do {
		zoom--;
		const tileSpan = 1 << zoom;
		tileCoordNW = latLngToTile(boundNW.lat, boundNW.lng, zoom);
		tileCoordSE = latLngToTile(boundSE.lat, boundSE.lng, zoom);
		cols = 1 + tileCoordSE.x - tileCoordNW.x;
		rows = 1 + tileCoordSE.y - tileCoordNW.y;

		if(cols < 0) {
			cols = 1 + (tileSpan - tileCoordNW.x) + tileCoordSE.x;
		}

		if(rows < 0) {
			rows = 1 + (tileSpan - tileCoordNW.y) + tileCoordSE.y;
		}
	}while(zoom > 0 && (cols > limit || rows > limit));

	return {zoom, cols, rows, tileCoordNW, tileCoordSE};
}

async function renderLayer(ctx, layer, zoom, x1, y1, cols, rows) {
	const tilePromises = [];
	const tileSpan = 1 << zoom;

	for(let y = y1; y < y1 + rows; y++) {
		for(let x = x1; x < x1 + cols; x++) {
			tilePromises.push(loadTile(x, y, zoom, layer));
		}
	}

	const tiles = await Promise.all(tilePromises);
	for(let t of tiles) {
		let x = t.x - x1;
		let y = t.y - y1;
		if(x < 0) x = x + tileSpan;
		if(y < 0) y = y + tileSpan;
		ctx.drawImage(t.img, x * TILE_SIZE, y * TILE_SIZE);
	}
}

function distanceFromPointInMetres(lat1, lng1, bearing, distance) {
	distance /= 6371e3;
	bearing = toRad(bearing);
	lat1 = toRad(lat1);
	lng1 = toRad(lng1);

	const slat1 = Math.sin(lat1);
	const clat1 = Math.cos(lat1);
	const sdist = Math.sin(distance);
	const cdist = Math.cos(distance);

	const lat2 = Math.asin(slat1 * cdist + clat1 * sdist * Math.cos(bearing));
	const lng2 = lng1 + Math.atan2(Math.sin(bearing) * sdist * clat1, cdist - slat1 * Math.sin(lat2));

	if(isNaN(lat2) || isNaN(lng2)) return null;
	return {lat: toDeg(lat2), lng: toDeg(lng2)};
}

export async function blueLineDetector(boundNW, boundSE) {
	const ctx = document.createElement('canvas').getContext('2d');
	const {zoom, cols, rows, tileCoordNW, tileCoordSE} = calculateZoom(boundNW, boundSE, MAX_TILES);

	ctx.canvas.width = TILE_SIZE * cols;
	ctx.canvas.height = TILE_SIZE * rows;

	await renderLayer(ctx, 'thin', zoom, tileCoordNW.x, tileCoordNW.y, cols, rows);

	const imageData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);

	return function(lat, lng, radius) {
		const cxr = distanceFromPointInMetres(lat, lng, 270, radius);
		const cyr = distanceFromPointInMetres(lat, lng, 180, radius);

		const point = latLngToCanvas(boundNW, tileCoordNW, lat, lng, zoom);
		const pointNW = latLngToCanvas(boundNW, tileCoordNW, cyr.lat, cxr.lng, zoom);

		let dx = point.x - pointNW.x;
		let dy = point.y - pointNW.y;
		if(dx < 0) dx *= -1;
		if(dy < 0) dy *= -1;

		return didOverlapCoverage(imageData, point.x, point.y, dx, dy);
	}
}
