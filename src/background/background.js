// Service Worker for Manifest V3

console.log("[yt-dlp grabber] Background script loaded");
let sessionStartedAt = Date.now();

let saveTimeout = null;
let pendingState = null;

async function debouncedSaveState(stateUpdate) {
  if (pendingState) {
    Object.assign(pendingState, stateUpdate);
  } else {
    pendingState = stateUpdate;
  }
  
  if (saveTimeout) clearTimeout(saveTimeout);
  
  saveTimeout = setTimeout(async () => {
    await browser.storage.local.set(pendingState);
    pendingState = null;
    broadcastStateChange();
  }, 300); // 300ms debounce window
}

async function getState() {
  const res = await browser.storage.local.get({
    detectedVideos: {},
    isRecording: false,
    recordedVideos: [],
    recordedVideoIds: [],
    videoReferers: {},
    videoTitles: {},
    videoIndexes: {}
  });
  return res;
}

async function saveState(stateUpdate) {
  await browser.storage.local.set(stateUpdate);
}

function broadcastStateChange() {
  browser.runtime.sendMessage({ type: "stateChanged" }).catch(() => {});
}

async function setReadyBadge(tabId) {
  try {
    await browser.action.setBadgeText({
      text: "1",
      tabId,
    });
    await browser.action.setBadgeBackgroundColor({
      color: "#1d4ed8",
      tabId,
    });
  } catch (e) {
    console.warn(`Could not set badge for tab ${tabId}:`, e.message);
  }
}

async function clearTabBadge(tabId) {
  try {
    await browser.action.setBadgeText({ text: null, tabId });
    await browser.action.setBadgeBackgroundColor({ color: null, tabId });
  } catch (e) {
    console.warn(`Could not clear badge for tab ${tabId}:`, e.message);
  }
}

async function clearAllReadyBadges(detectedVideos) {
  const promises = Object.keys(detectedVideos).map(async (tabIdStr) => {
    const tabId = Number(tabIdStr);
    if (tabId >= 0) await clearTabBadge(tabId);
  });
  await Promise.all(promises);
}

async function restoreReadyBadges(detectedVideos) {
  const promises = Object.keys(detectedVideos).map(async (tabIdStr) => {
    const tabId = Number(tabIdStr);
    if (tabId >= 0) await setReadyBadge(tabId);
  });
  await Promise.all(promises);
}

async function updateRecordingBadge(isRecording, recordedVideos, detectedVideos) {
  if (isRecording) {
    await browser.action.setBadgeText({ text: String(recordedVideos.length) });
    await browser.action.setBadgeBackgroundColor({ color: "#b91c1c" });
  } else {
    await browser.action.setBadgeText({ text: "" });
    await restoreReadyBadges(detectedVideos);
  }
}

// Listener for network requests
browser.webRequest.onCompleted.addListener(
  async (details) => {
    const match = details.url.match(/player\.vimeo\.com\/video\/(\d+)/);
    if (!match) return;

    const tabId = details.tabId;
    const videoId = match[1];

    let h = "";
    try {
      h = new URL(details.url).searchParams.get("h") || "";
    } catch (_) {}

    let cleanUrl = `https://player.vimeo.com/video/${videoId}`;
    if (h) cleanUrl += `?h=${h}`;

    let referer = details.initiator;
    let tabTitle = "Unknown Page";
    let tabIndex = 99999;
    let windowId = 0;

    if (tabId >= 0) {
      try {
        const tab = await browser.tabs.get(tabId);
        if (tab) {
          if (tab.url && !referer) referer = tab.url;
          if (tab.title) tabTitle = tab.title;
          if (tab.index !== undefined) tabIndex = tab.index;
          if (tab.windowId !== undefined) windowId = tab.windowId;
        }
      } catch (e) {}
    }
    
    try {
      if (referer) {
        const urlObj = new URL(referer);
        referer = urlObj.origin + "/";
      } else {
        referer = "https://player.vimeo.com/";
      }
    } catch(e) {
      if (!referer.endsWith("/")) referer += "/";
    }

    const state = await getState();
    let stateChanged = false;
    state.videoReferers = state.videoReferers || {};
    state.videoTitles = state.videoTitles || {};
    state.videoIndexes = state.videoIndexes || {};

    // 1. Handle tab-specific detection
    if (tabId >= 0) {
      state.detectedVideos[tabId] = {
        url: cleanUrl,
        videoId,
        referer,
        title: tabTitle,
        windowId,
        tabIndex,
        timestamp: Date.now()
      };
      stateChanged = true;

      if (!state.isRecording) {
        await setReadyBadge(tabId);
      }
    }

    // 2. Handle global recording mode
    if (state.isRecording) {
      if (!state.recordedVideoIds.includes(videoId)) {
        state.recordedVideoIds.push(videoId);
        state.recordedVideos.push(cleanUrl);
        state.videoReferers[videoId] = referer;
        state.videoTitles[videoId] = tabTitle;
        state.videoIndexes[videoId] = { windowId, tabIndex };
        console.log("[yt-dlp grabber] Recorded URL:", cleanUrl, "Tab Index:", tabIndex);
        stateChanged = true;
        await updateRecordingBadge(state.isRecording, state.recordedVideos, state.detectedVideos);
      }
    }

    if (stateChanged) {
      debouncedSaveState({
        detectedVideos: state.detectedVideos,
        recordedVideos: state.recordedVideos,
        recordedVideoIds: state.recordedVideoIds,
        videoReferers: state.videoReferers,
        videoTitles: state.videoTitles,
        videoIndexes: state.videoIndexes
      });
    }
  },
  { urls: ["<all_urls>"] }
);

// Clean up when a tab is closed
browser.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.detectedVideos[tabId]) {
    delete state.detectedVideos[tabId];
    await saveState({ detectedVideos: state.detectedVideos });
    broadcastStateChange();
  }
});

// Clean up when a tab navigates to a new page
browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    const state = await getState();
    if (state.detectedVideos[tabId]) {
      delete state.detectedVideos[tabId];
      await saveState({ detectedVideos: state.detectedVideos });
      if (!state.isRecording) {
        await clearTabBadge(tabId);
      }
      broadcastStateChange();
    }
  }
});

// Message listener
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getVideos") {
    (async () => {
      const state = await getState();
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      sendResponse({
        tabVideo: state.detectedVideos[tabId] || null,
        isRecording: state.isRecording,
        recordedVideos: state.recordedVideos,
        videoReferers: state.videoReferers || {},
        videoTitles: state.videoTitles || {},
        videoIndexes: state.videoIndexes || {},
        sessionStartedAt: sessionStartedAt
      });
    })();
    return true; // async response
  }

  if (msg.type === "startRecording") {
    (async () => {
      const state = await getState();
      await clearAllReadyBadges(state.detectedVideos);
      await saveState({ isRecording: true, recordedVideos: [], recordedVideoIds: [] });
      await updateRecordingBadge(true, [], state.detectedVideos);
      sendResponse({ success: true });
      broadcastStateChange();
    })();
    return true;
  }

  if (msg.type === "stopRecording") {
    (async () => {
      const state = await getState();
      await saveState({ isRecording: false });
      await updateRecordingBadge(false, state.recordedVideos, state.detectedVideos);
      sendResponse({ success: true, recordedVideos: state.recordedVideos });
      broadcastStateChange();
    })();
    return true;
  }

  if (msg.type === "clearRecording") {
    (async () => {
      const state = await getState();
      await saveState({ recordedVideos: [], recordedVideoIds: [] });
      await updateRecordingBadge(state.isRecording, [], state.detectedVideos);
      sendResponse({ success: true });
      broadcastStateChange();
    })();
    return true;
  }

  if (msg.type === "clearTabVideo") {
    (async () => {
      const state = await getState();
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (tabId >= 0 && state.detectedVideos[tabId]) {
        delete state.detectedVideos[tabId];
        await saveState({ detectedVideos: state.detectedVideos });
        if (!state.isRecording) {
          await clearTabBadge(tabId);
        }
      }
      sendResponse({ success: true });
      broadcastStateChange();
    })();
    return true;
  }

  if (msg.type === "resetSession") {
    sessionStartedAt = Date.now();
    sendResponse({ success: true, sessionStartedAt });
    broadcastStateChange();
    return true;
  }
});


