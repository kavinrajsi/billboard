// Sample corridors, sensor points and cache TTLs. Edit freely.

// Traffic corridors sampled with the Routes API (Google has no citywide live feed).
export const CORRIDORS = [
  {
    id: "tnagar-guindy",
    name: "T. Nagar → Guindy",
    origin: { latitude: 13.0418, longitude: 80.2341 },
    destination: { latitude: 13.0067, longitude: 80.2206 },
  },
  {
    id: "anna-salai",
    name: "Anna Salai: Spencer Plaza → Saidapet",
    origin: { latitude: 13.0632, longitude: 80.2614 },
    destination: { latitude: 13.0213, longitude: 80.2231 },
  },
  {
    id: "omr-north",
    name: "OMR: Madhya Kailash → Sholinganallur",
    origin: { latitude: 13.0063, longitude: 80.2512 },
    destination: { latitude: 12.9010, longitude: 80.2279 },
  },
  {
    id: "ecr",
    name: "ECR: Thiruvanmiyur → Neelankarai",
    origin: { latitude: 12.9826, longitude: 80.2592 },
    destination: { latitude: 12.9497, longitude: 80.2561 },
  },
  {
    id: "poonamallee-high-road",
    name: "Poonamallee High Rd: Central → Koyambedu",
    origin: { latitude: 13.0827, longitude: 80.2755 },
    destination: { latitude: 13.0694, longitude: 80.1948 },
  },
];

// Points for Air Quality lookups.
export const AIR_POINTS = [
  { name: "Anna Nagar", latitude: 13.0850, longitude: 80.2101 },
  { name: "T. Nagar", latitude: 13.0418, longitude: 80.2341 },
  { name: "Marina / Triplicane", latitude: 13.0500, longitude: 80.2824 },
  { name: "Guindy", latitude: 13.0067, longitude: 80.2206 },
  { name: "Adyar", latitude: 13.0012, longitude: 80.2565 },
  { name: "Perungudi", latitude: 12.9611, longitude: 80.2420 },
  { name: "Ambattur", latitude: 13.1143, longitude: 80.1548 },
  { name: "Manali", latitude: 13.1663, longitude: 80.2581 },
];

// Single point for the weather HUD.
export const WEATHER_POINT = { name: "Chennai", latitude: 13.0827, longitude: 80.2707 };

// Server-side cache TTLs in milliseconds. Keeps API spend low when many clients poll.
export const CACHE_TTL = {
  traffic: 2 * 60 * 1000,
  air: 15 * 60 * 1000,
  weather: 15 * 60 * 1000,
};
