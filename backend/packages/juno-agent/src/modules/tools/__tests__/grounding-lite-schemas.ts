/**
 * `inputSchema` of two Google Maps Grounding Lite tools exactly as https://mapstools.googleapis.com/mcp listed them (tools/list, 2026-11-02),
 * with only the `description` and `x-google-enum-descriptions` text dropped. Every object field is a `$ref` into `$defs` and nothing else
 * (no `type`, no `oneOf`), which is the shape that let a JSON-encoded string through (seen 2026-11-02).
 */
const latLng = { properties: { latitude: { format: 'double', type: 'number' }, longitude: { format: 'double', type: 'number' } }, type: 'object' };

export const computeRoutesSchema = {
  $defs: {
    LatLng: latLng,
    Waypoint: { properties: { address: { type: 'string' }, latLng: { $ref: '#/$defs/LatLng' }, placeId: { type: 'string' } }, type: 'object' },
  },
  properties: {
    arrivalTime: { format: 'date-time', type: 'string' },
    computeAlternativeRoutes: { type: 'boolean' },
    departureTime: { format: 'date-time', type: 'string' },
    destination: { $ref: '#/$defs/Waypoint' },
    includePolyline: { type: 'boolean' },
    intermediateWaypoints: { items: { $ref: '#/$defs/Waypoint' }, type: 'array' },
    locationBias: { $ref: '#/$defs/LatLng' },
    origin: { $ref: '#/$defs/Waypoint' },
    routingPreference: { enum: ['ROUTING_PREFERENCE_UNSPECIFIED', 'ROUTING_PREFERENCE_TRAFFIC_UNAWARE', 'ROUTING_PREFERENCE_TRAFFIC_AWARE_OPTIMAL'], type: 'string' },
    travelMode: { enum: ['ROUTE_TRAVEL_MODE_UNSPECIFIED', 'DRIVE', 'WALK', 'BICYCLE', 'TRANSIT'], type: 'string' },
  },
  required: ['origin', 'destination'],
  type: 'object',
};

export const lookupWeatherSchema = {
  $defs: {
    AirQualityOptions: { properties: { includePollutantConcentration: { type: 'boolean' }, indexRegionCode: { type: 'string' } }, type: 'object' },
    Date: { properties: { day: { format: 'int32', type: 'integer' }, month: { format: 'int32', type: 'integer' }, year: { format: 'int32', type: 'integer' } }, type: 'object' },
    LatLng: latLng,
    Location: { properties: { address: { type: 'string' }, latLng: { $ref: '#/$defs/LatLng' }, placeId: { type: 'string' } }, type: 'object' },
    WeatherOptions: { properties: { unitsSystem: { enum: ['UNITS_SYSTEM_UNSPECIFIED', 'IMPERIAL', 'METRIC'], type: 'string' } }, type: 'object' },
  },
  properties: {
    airQualityOptions: { $ref: '#/$defs/AirQualityOptions' },
    capabilities: { items: { enum: ['CAPABILITY_UNSPECIFIED', 'WEATHER', 'AIR_QUALITY', 'POLLEN'], type: 'string' }, type: 'array' },
    date: { $ref: '#/$defs/Date' },
    hour: { format: 'int32', type: 'integer' },
    languageCode: { type: 'string' },
    location: { $ref: '#/$defs/Location' },
    unitsSystem: { enum: ['UNITS_SYSTEM_UNSPECIFIED', 'IMPERIAL', 'METRIC'], type: 'string' },
    weatherOptions: { $ref: '#/$defs/WeatherOptions' },
  },
  required: ['location'],
  type: 'object',
};
