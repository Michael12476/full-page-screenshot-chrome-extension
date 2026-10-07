importScripts("capture.js");

// Chrome's screenshot quota is shared across tabs, so run one capture at a time.
let job = null;

async function showStatus(tabId, text, title, color = "#2563eb") {
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setTitle({ tabId, title });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "page-shot:capture") return;
  if (!job || sender.tab?.id !== job.tabId || sender.frameId !== 0 || message.session !== job.session) {
    reply({ error: "This capture is no longer active. Click Page Shot again." });
    return;
  }
  const currentJob = job;
  (async () => {
    const before = await chrome.tabs.get(currentJob.tabId);
    if (!before.active) throw new Error("Keep the page's tab selected until capture finishes.");
    const dataUrl = await chrome.tabs.captureVisibleTab(currentJob.windowId, { format: "png" });
    const after = await chrome.tabs.get(currentJob.tabId);
    if (!after.active || after.url !== before.url || job !== currentJob) {
      throw new Error("The tab changed during capture. Click Page Shot again.");
    }
    await showStatus(currentJob.tabId, String(message.frame), "Capturing page. Keep this tab selected.");
    return { dataUrl };
  })().then(reply, error => reply({ error: error.message }));
  return true;
});

chrome.action.onClicked.addListener(async tab => {
  if (job) return;
  job = { tabId: tab.id, windowId: tab.windowId, session: crypto.randomUUID() };
  try {
    if (!/^(https?:|file:)/.test(tab.url || "")) {
      throw new Error("Open a website first. Chrome settings, the Web Store, and PDF viewers cannot be scrolled by this extension.");
    }
    await showStatus(tab.id, "...", "Loading page content. Keep this tab selected.");
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: capturePage,
      args: [job.session]
    });
    if (!result?.result) throw new Error("The page closed or navigated during capture.");
    const { dataUrl, title } = result.result;
    const name = [...title.replace(/[^\p{L}\p{M}\p{N} _()-]+/gu, "-")].slice(0, 90).join("") || "page";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    await chrome.downloads.download({
      url: dataUrl,
      filename: `page-shot-${name}-${timestamp}.png`,
      saveAs: false,
      conflictAction: "uniquify"
    });
    await showStatus(tab.id, "OK", "Screenshot sent to Downloads. Click to capture again.", "#15803d");
  } catch (error) {
    console.error("Page Shot:", error);
    await showStatus(tab.id, "ERR", error.message, "#b91c1c").catch(console.error);
  } finally {
    job = null;
  }
});
