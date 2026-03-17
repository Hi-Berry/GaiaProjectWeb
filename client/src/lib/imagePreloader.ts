export const preloadImages = (urls: string[]) => {
  if (typeof window === 'undefined') return;
  urls.forEach((url) => {
    const img = new Image();
    img.src = url;
  });
};
