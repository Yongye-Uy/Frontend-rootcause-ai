// Auto-detect environment: use local backend if on localhost, otherwise use the deployed Render backend
if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
  window.API_ORIGIN = "";
} else {
  window.API_ORIGIN = "https://backend-rootcause-ai.onrender.com";
}
