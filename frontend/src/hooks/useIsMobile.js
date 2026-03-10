import { useEffect, useState } from "react";

function useIsMobile(breakpoint = 1024) {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < breakpoint;
  });

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const mediaQuery = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = (event) => setIsMobile(event.matches);

    setIsMobile(mediaQuery.matches);
    mediaQuery.addEventListener("change", onChange);

    return () => mediaQuery.removeEventListener("change", onChange);
  }, [breakpoint]);

  return isMobile;
}

export default useIsMobile;
