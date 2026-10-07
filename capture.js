// Serialized into Chrome's isolated content-script world. Keep dependencies inside this function.
async function capturePage(session) {
  const MAX_SIDE = 32767;
  const MAX_PIXELS = 64_000_000;
  const DEADLINE_MS = 90_000;
  const originalX = scrollX;
  const originalY = scrollY;
  const viewportWidth = innerWidth;
  const viewportHeight = innerHeight;
  const started = Date.now();
  const changedStyles = [];
  const fixedElements = [];
  const fixedFooters = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const root = document.scrollingElement;
  if (!root) throw new Error("This page has no document scroller.");
  const size = () => ({
    width: root.scrollWidth,
    height: root.scrollHeight
  });
  function checkSize(width, height, scale = devicePixelRatio) {
    if (width * scale > MAX_SIDE || height * scale > MAX_SIDE || width * height * scale * scale > MAX_PIXELS) {
      throw new Error("This page is too large for one PNG. Reduce Chrome's zoom and try again.");
    }
    if (Date.now() - started > DEADLINE_MS) {
      throw new Error("Capture took too long. Infinite scrolling pages cannot be captured completely.");
    }
  }
  function changeStyle(element, property, value) {
    changedStyles.push([element, property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]);
    element.style.setProperty(property, value, "important");
  }
  const style = document.createElement("style");
  style.textContent = "* { scroll-behavior: auto !important; scroll-snap-type: none !important; overflow-anchor: none !important; animation-play-state: paused !important; caret-color: transparent !important; }";
  document.documentElement.append(style);
  let canvas;
  try {
    // Load lazy content before fixing the output dimensions.
    for (let y = 0; ; y += viewportHeight) {
      const page = size();
      checkSize(page.width, page.height);
      scrollTo(0, y);
      await pause(250);
      const loaded = size();
      if (y + viewportHeight >= loaded.height) {
        await pause(500);
        if (y + viewportHeight >= size().height) break;
      }
    }
    for (const element of document.querySelectorAll("*")) {
      const position = getComputedStyle(element).position;
      if (position === "sticky") {
        changeStyle(element, "position", "relative");
        for (const property of ["top", "right", "bottom", "left"]) changeStyle(element, property, "auto");
      }
      if (position === "fixed") {
        const rect = element.getBoundingClientRect();
        // ponytail: lower-half fixed overlays are footers; inspect anchors if other placements need handling.
        if (rect.height > 0 && rect.top >= root.clientHeight / 2) {
          fixedFooters.push({ element, visibility: getComputedStyle(element).visibility });
          changeStyle(element, "visibility", "hidden");
        } else fixedElements.push(element);
      }
    }
    scrollTo(0, 0);
    await pause(600);
    const page = size();
    checkSize(page.width, page.height);
    // Include viewport space on short pages, and exclude the scrollbar on long ones.
    const width = Math.max(page.width, root.clientWidth);
    const height = Math.max(page.height, root.clientHeight);
    const stepX = Math.max(1, root.clientWidth);
    const stepY = Math.max(1, root.clientHeight);
    let frame = 0;
    let scale;
    let context;
    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        checkSize(width, height, scale);
        scrollTo(x, y);
        const footerFrame = y + stepY >= height && x === 0;
        for (const footer of fixedFooters) {
          footer.element.style.setProperty("visibility", footerFrame ? footer.visibility : "hidden", "important");
        }
        // captureVisibleTab allows at most two calls per second.
        await pause(600);
        const actualX = scrollX;
        const actualY = scrollY;
        if (Math.abs(actualX - Math.min(x, Math.max(0, width - stepX))) > 1 ||
            Math.abs(actualY - Math.min(y, Math.max(0, height - stepY))) > 1) {
          throw new Error("This page prevents scrolling. Open a page with normal document scrolling.");
        }
        const response = await chrome.runtime.sendMessage({ type: "page-shot:capture", session, frame: ++frame });
        if (response.error) throw new Error(response.error);
        if (innerWidth !== viewportWidth || innerHeight !== viewportHeight || scrollX !== actualX || scrollY !== actualY) {
          throw new Error("The page moved or resized during capture. Keep it still and try again.");
        }
        const currentSize = size();
        if (currentSize.width !== page.width || currentSize.height !== page.height) {
          throw new Error("The page is still loading. Wait for it to finish, then capture again.");
        }
        const bitmap = await createImageBitmap(await (await fetch(response.dataUrl)).blob());
        try {
          const bitmapScale = bitmap.width / viewportWidth;
          if (scale !== undefined && Math.abs(bitmapScale - scale) > 0.001) {
            throw new Error("Chrome's zoom changed during capture. Try again.");
          }
          if (!canvas) {
            scale = bitmapScale;
            checkSize(width, height, scale);
            canvas = document.createElement("canvas");
            canvas.width = Math.round(width * scale);
            canvas.height = Math.round(height * scale);
            context = canvas.getContext("2d");
            if (!context) throw new Error("Chrome could not create the screenshot image.");
          }
          const left = Math.round(x * scale);
          const top = Math.round(y * scale);
          const tileWidth = Math.min(canvas.width, Math.round((x + stepX) * scale)) - left;
          const tileHeight = Math.min(canvas.height, Math.round((y + stepY) * scale)) - top;
          // Chrome clamps the last scroll. Crop its overlap instead of replacing earlier tiles.
          context.drawImage(bitmap, left - Math.round(actualX * scale), top - Math.round(actualY * scale),
            tileWidth, tileHeight, left, top, tileWidth, tileHeight);
          // Place bottom toolbars at the page's end, including any part above the final tile's crop.
          if (footerFrame) {
            for (const { element } of fixedFooters) {
              const rect = element.getBoundingClientRect();
              const footerLeft = Math.max(0, Math.round(rect.left * scale));
              const footerTop = Math.max(0, Math.round(rect.top * scale));
              const footerWidth = Math.min(Math.round(stepX * scale), Math.round(rect.right * scale)) - footerLeft;
              const footerHeight = Math.min(Math.round(stepY * scale), Math.round(rect.bottom * scale)) - footerTop;
              if (footerWidth > 0 && footerHeight > 0) {
                context.drawImage(bitmap, footerLeft, footerTop, footerWidth, footerHeight,
                  Math.round(actualX * scale) + footerLeft, Math.round(actualY * scale) + footerTop, footerWidth, footerHeight);
              }
            }
          }
        } finally {
          bitmap.close();
        }
        if (frame === 1) {
          // Fixed headers appear once rather than at every stitch.
          for (const element of fixedElements) changeStyle(element, "visibility", "hidden");
        }
        if (actualX + stepX >= width) break;
      }
      if (scrollY + stepY >= height) break;
    }
    const dataUrl = canvas.toDataURL("image/png");
    // ponytail: one PNG and one message, split into files if huge captures become necessary.
    if (dataUrl === "data:," || dataUrl.length > 60_000_000) {
      throw new Error("The PNG is too large to save. Reduce Chrome's zoom and try again.");
    }
    return { dataUrl, title: document.title };
  } finally {
    if (canvas) canvas.width = canvas.height = 0;
    for (const [element, property, value, priority] of changedStyles.reverse()) {
      if (value) element.style.setProperty(property, value, priority);
      else element.style.removeProperty(property);
    }
    scrollTo(originalX, originalY);
    style.remove();
  }
}
