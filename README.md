# Full Page Screenshot Chrome Extension

In Chrome it appears as **Page Shot**.

Click the extension's camera icon to capture a full page as a PNG. It scrolls to load lazy content, stitches the screenshots, restores your scroll position, and automatically saves to Chrome's configured Downloads folder.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** in the top right.
3. Click **Load unpacked** and select this `full-page-screenshot-chrome-extension` folder.
4. Open Chrome's puzzle-piece Extensions menu and pin **Page Shot**.

On a website, click the camera icon once. Keep that tab selected and avoid scrolling or resizing until the badge says **OK**. Chrome's Downloads list shows the saved file. **ERR** means capture failed; hover over the icon to read the error.

Fixed headers appear once at the top. Fixed bottom toolbars appear once at the page's end at their original viewport width, so they do not cover content halfway through the PNG. After source changes, click the reload arrow on Page Shot's card in `chrome://extensions`.

The filename includes the page title and time. No screenshot data leaves your computer. It only requests access to a page when you click it, plus permission to save downloads.

Chrome settings, the Chrome Web Store, and built-in PDF viewers restrict script injection. Local files require **Allow access to file URLs** in the extension's Details page. Infinite feeds and separate scrolling panels are not supported. Images are limited to 32,767 pixels per side and 64 million pixels; zoom out for very long pages. Live video, loading content, and animations may change between frames.

Headers inside web components or headers that become fixed while scrolling may repeat. Filename times use UTC.

## Check

Run `node check.mjs` from this folder. No packages or build step are needed.

The capture and download APIs follow [Chrome's tabs documentation](https://developer.chrome.com/docs/extensions/reference/api/tabs) and [downloads documentation](https://developer.chrome.com/docs/extensions/reference/api/downloads).

## License

[MIT](LICENSE)
