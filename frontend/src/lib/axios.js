import axios from "axios";

const normalizeApiUrl = (value) => {
  if (!value) return "/api";

  const url = value.trim();

  if (url.startsWith("/")) {
    return url === "/" ? "/api" : url.replace(/\/$/, "");
  }

  try {
    const parsed = new URL(url);
    if (!parsed.pathname || parsed.pathname === "/") {
      parsed.pathname = "/api";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "/api";
  }
};

const axiosInstance = axios.create({
  baseURL: normalizeApiUrl(import.meta.env.VITE_API_URL),
  withCredentials: true, // by adding this field browser will send the cookies to server automatically, on every single req
});

export default axiosInstance;
