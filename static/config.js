// Backend origin the frontend talks to.
// Leave empty ("") for local dev, where FastAPI serves this frontend itself
// (relative /api/... calls hit the same origin). When the frontend is deployed
// separately (e.g. on Vercel), set this to the deployed backend's URL, e.g.:
//   window.API_ORIGIN = "https://rootcause-ai-backend.onrender.com";
window.API_ORIGIN = "https://backend-rootcause-ai.onrender.com";
