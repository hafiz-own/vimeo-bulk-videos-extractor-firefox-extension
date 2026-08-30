// Elements
const content = document.getElementById("content");
const recordBtn = document.getElementById("record-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const messageBar = document.getElementById("message-bar");

const bulkSection = document.getElementById("bulk-result-section");
const bulkCmdBox = document.getElementById("bulk-cmd-box");
const bulkCopyBtn = document.getElementById("bulk-copy-btn");
const bulkExportBtn = document.getElementById("bulk-export-btn");

const queueSection = document.getElementById("queue-section");
const queueList = document.getElementById("queue-list");
const queueSelectAllBtn = document.getElementById("queue-select-all-btn");
const queueSelectNoneBtn = document.getElementById("queue-select-none-btn");

const clearBulkBtn = document.getElementById("clear-bulk-btn");
const clearTabBtn = document.getElementById("clear-tab-btn");
const clearHistoryBtn = document.getElementById("clear-history-btn");
const profileSelect = document.getElementById("profile-select");
const profileChip = document.getElementById("profile-chip");

const statCaptured = document.getElementById("stat-captured");
const statUnique = document.getElementById("stat-unique");
const statDuplicates = document.getElementById("stat-duplicates");
const statHistory = document.getElementById("stat-history");
const statSessionTime = document.getElementById("stat-session-time");
const statNewSince = document.getElementById("stat-new-since");
const statProfileBreakdown = document.getElementById("stat-profile-breakdown");

const DEFAULT_PROFILE_KEY = "p480";
const UI_REFRESH_DEBOUNCE_MS = 200;

const DOWNLOAD_PROFILES = {
  p480: {
    label: "480p (Recommended)",
    format: "bestvideo[height<=480]+bestaudio/best[height<=480]/best"
  },
  p720: {
    label: "720p",
    format: "bestvideo[height<=720]+bestaudio/best[height<=720]/best"
  },
  p1080: {
    label: "1080p",
    format: "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"
  },
  best: {
    label: "Best Available",
    format: "bestvideo+bestaudio/best"
  },
  audio: {
    label: "Audio Only",
    format: "bestaudio/best",
    extraArgs: ["-x", "--audio-format m4a"]
  }
};

let selectedProfileKey = DEFAULT_PROFILE_KEY;
let messageTimer = null;
let refreshTimer = null;
let updateInFlight = false;
let needsRefreshAfterCurrent = false;

let lastKnownState = {
  tabVideo: null,
  isRecording: false,
  recordedVideos: [],
  videoReferers: {},
  history: []
};

let queueOrderIds = [];
let queueUrlById = {};
let selectedQueueIds = new Set();
let excludedQueueIds = new Set();

let sessionStartedAt = Date.now();
let lastBulkActionCapturedCount = 0;
const profileUsageCounts = {
  p480: 0,
  p720: 0,
  p1080: 0,
  best: 0,
  audio: 0
};

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "stateChanged") {
    scheduleUpdateUI();
  }
});

bindProfileSelector();
bindStaticActions();

loadSelectedProfile()
  .then(() => {
    updateProfileUI();
    return updateUI();
  })
  .catch((error) => handleError("Failed to initialize UI", error));

function scheduleUpdateUI() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    updateUI().catch((error) => handleError("Failed to refresh UI", error));
  }, UI_REFRESH_DEBOUNCE_MS);
}

function bindProfileSelector() {
  profileSelect.addEventListener("change", async () => {
    const nextKey = profileSelect.value;
    if (!DOWNLOAD_PROFILES[nextKey]) return;

    selectedProfileKey = nextKey;
    updateProfileUI();
    renderBulkCommand();

    try {
      await browser.storage.local.set({ selectedProfileKey });
    } catch (error) {
      handleError("Failed to save selected profile", error);
    }
  });
}

function bindStaticActions() {
  recordBtn.addEventListener("click", onRecordButtonClick);
  clearBulkBtn.addEventListener("click", onClearBulkClick);
  clearTabBtn.addEventListener("click", onClearTabClick);
  clearHistoryBtn.addEventListener("click", onClearHistoryClick);
  bulkCopyBtn.addEventListener("click", onBulkCopyClick);
  bulkExportBtn.addEventListener("click", onBulkExportClick);
  queueSelectAllBtn.addEventListener("click", onQueueSelectAll);
  queueSelectNoneBtn.addEventListener("click", onQueueSelectNone);
}

async function loadSelectedProfile() {
  const res = await browser.storage.local.get("selectedProfileKey");
  if (DOWNLOAD_PROFILES[res.selectedProfileKey]) {
    selectedProfileKey = res.selectedProfileKey;
  }
  profileSelect.value = selectedProfileKey;
}

function getSelectedProfile() {
  return DOWNLOAD_PROFILES[selectedProfileKey] || DOWNLOAD_PROFILES[DEFAULT_PROFILE_KEY];
}

function updateProfileUI() {
  const profile = getSelectedProfile();
  profileSelect.value = selectedProfileKey;
  profileChip.textContent = profile.label;
}

function showMessage(text, type = "error") {
  if (!messageBar) return;
  if (messageTimer) clearTimeout(messageTimer);
  messageBar.textContent = text;
  messageBar.className = `message-bar ${type}`;
  messageBar.classList.remove("hidden");
  messageTimer = setTimeout(() => {
    messageBar.classList.add("hidden");
  }, type === "error" ? 3500 : 1800);
}

function handleError(context, error) {
  console.error(context, error);
  showMessage(context, "error");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function extractVideoId(url) {
  const match = String(url).match(/\/video\/(\d+)/);
  return match ? match[1] : null;
}

function buildYtDlpCommand(urls, options = {}) {
  const { withAutonumber = false, referer = "" } = options;
  const profile = getSelectedProfile();
  const safeUrls = Array.isArray(urls) ? urls.filter(Boolean) : [];

  const lines = [
    'yt-dlp --embed-subs --sub-langs "en.*" --embed-metadata --embed-chapters',
    '  --downloader aria2c',
    '  --downloader-args "aria2c:-x 16 -s 16 -k 1M --min-split-size 1M"',
    `  -f "${profile.format}"`
  ];

  if (profile.extraArgs) {
    profile.extraArgs.forEach((arg) => lines.push(`  ${arg}`));
  }

  if (withAutonumber) {
    lines.push('  --autonumber-start 1');
    lines.push('  -o "%(autonumber)d - %(title)s.%(ext)s"');
  }

  if (referer) {
    lines.push(`  --referer "${referer}"`);
  }

  const formattedUrls = safeUrls.map(shellQuote).join(" ");
  lines.push(`  ${formattedUrls}`);
  return lines.join(" \\\n");
}

function syncQueue(recordedVideos) {
  const currentMap = {};
  const incomingOrder = [];
  const allIncomingIds = new Set();

  recordedVideos.forEach((url, index) => {
    const parsedId = extractVideoId(url);
    const id = parsedId || `url-${index}`;
    allIncomingIds.add(id);
    if (excludedQueueIds.has(id)) return;
    if (currentMap[id]) return;
    currentMap[id] = url;
    incomingOrder.push(id);
  });

  const incomingIdSet = new Set(incomingOrder);
  queueOrderIds = incomingOrder;

  queueUrlById = currentMap;

  selectedQueueIds = new Set(
    [...selectedQueueIds].filter((id) => Object.prototype.hasOwnProperty.call(queueUrlById, id))
  );
  queueOrderIds.forEach((id) => {
    if (!selectedQueueIds.has(id)) selectedQueueIds.add(id);
  });

  excludedQueueIds = new Set([...excludedQueueIds].filter((id) => allIncomingIds.has(id)));
}

function getQueueEntries() {
  return queueOrderIds
    .filter((id) => Object.prototype.hasOwnProperty.call(queueUrlById, id))
    .map((id) => ({
      id,
      url: queueUrlById[id]
    }));
}

function getActiveQueueEntries() {
  return getQueueEntries().filter((entry) => selectedQueueIds.has(entry.id));
}

function renderQueue() {
  const entries = getQueueEntries();
  if (entries.length === 0) {
    queueSection.classList.add("hidden");
    queueList.textContent = "";
    return;
  }

  queueSection.classList.remove("hidden");
  queueList.textContent = "";

  entries.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "queue-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedQueueIds.has(entry.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedQueueIds.add(entry.id);
      else selectedQueueIds.delete(entry.id);
      renderBulkCommand();
      renderStats(lastKnownState.recordedVideos, lastKnownState.history);
    });

    const label = document.createElement("div");
    label.className = "queue-item-label";
    const title = lastKnownState.videoTitles[entry.id] || "Unknown Page";
    label.textContent = `${index + 1}. ${title} (${entry.id})`;
    label.title = entry.url;

    const controls = document.createElement("div");
    controls.className = "queue-item-controls";

    const upBtn = document.createElement("button");
    upBtn.className = "queue-btn";
    upBtn.title = "Move up";
    upBtn.textContent = "↑";
    upBtn.disabled = index === 0;
    upBtn.addEventListener("click", () => {
      if (index === 0) return;
      [queueOrderIds[index - 1], queueOrderIds[index]] = [queueOrderIds[index], queueOrderIds[index - 1]];
      renderQueue();
      renderBulkCommand();
    });

    const downBtn = document.createElement("button");
    downBtn.className = "queue-btn";
    downBtn.title = "Move down";
    downBtn.textContent = "↓";
    downBtn.disabled = index === entries.length - 1;
    downBtn.addEventListener("click", () => {
      if (index === entries.length - 1) return;
      [queueOrderIds[index + 1], queueOrderIds[index]] = [queueOrderIds[index], queueOrderIds[index + 1]];
      renderQueue();
      renderBulkCommand();
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "queue-btn";
    removeBtn.title = "Remove";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      excludedQueueIds.add(entry.id);
      selectedQueueIds.delete(entry.id);
      queueOrderIds = queueOrderIds.filter((id) => id !== entry.id);
      delete queueUrlById[entry.id];
      renderQueue();
      renderBulkCommand();
      renderStats(lastKnownState.recordedVideos, lastKnownState.history);
    });

    controls.appendChild(upBtn);
    controls.appendChild(downBtn);
    controls.appendChild(removeBtn);

    row.appendChild(checkbox);
    row.appendChild(label);
    row.appendChild(controls);
    queueList.appendChild(row);
  });
}

function renderBulkCommand() {
  const entries = getQueueEntries();
  if (entries.length === 0) {
    bulkSection.classList.add("hidden");
    bulkCmdBox.textContent = "yt-dlp ...";
    bulkCopyBtn.disabled = true;
    bulkExportBtn.disabled = true;
    return;
  }

  bulkSection.classList.remove("hidden");
  const selectedUrls = getActiveQueueEntries().map((entry) => entry.url);

  if (selectedUrls.length === 0) {
    bulkCmdBox.textContent = "Select at least one queue item to generate a command.";
    bulkCopyBtn.disabled = true;
    bulkExportBtn.disabled = true;
    return;
  }

  bulkCopyBtn.disabled = false;
  bulkExportBtn.disabled = false;
  
  let referer = "";
  if (getActiveQueueEntries().length > 0) {
    const firstId = getActiveQueueEntries()[0].id;
    referer = lastKnownState.videoReferers[firstId] || "";
  }

  bulkCmdBox.textContent = buildYtDlpCommand(selectedUrls, { withAutonumber: true, referer });
}

function renderStats(recordedVideos, history) {
  const ids = recordedVideos.map(extractVideoId).filter(Boolean);
  const uniqueCount = new Set(ids).size;
  const capturedCount = recordedVideos.length;
  const duplicateCount = Math.max(0, capturedCount - uniqueCount);
  const queueCount = getQueueEntries().length;
  const newSince = Math.max(0, queueCount - lastBulkActionCapturedCount);

  statCaptured.textContent = String(capturedCount);
  statUnique.textContent = String(uniqueCount);
  statDuplicates.textContent = String(duplicateCount);
  statHistory.textContent = String(history.length);
  statNewSince.textContent = String(newSince);

  const profileLines = Object.entries(profileUsageCounts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${DOWNLOAD_PROFILES[key].label}: ${count}`);
  statProfileBreakdown.textContent = profileLines.length > 0 ? profileLines.join(" | ") : "No actions yet";
}

async function updateUI() {
  if (updateInFlight) {
    needsRefreshAfterCurrent = true;
    return;
  }

  updateInFlight = true;
  try {
    const [response, history] = await Promise.all([
      browser.runtime.sendMessage({ type: "getVideos" }),
      getCopiedHistory()
    ]);

    const { tabVideo, isRecording, recordedVideos, videoReferers, videoTitles, videoIndexes, sessionStartedAt: bgSessionTime } = response;
    
    if (bgSessionTime) {
      sessionStartedAt = bgSessionTime;
    }
    
    let sortedVideos = Array.isArray(recordedVideos) ? [...recordedVideos] : [];
    if (videoIndexes) {
      sortedVideos.sort((urlA, urlB) => {
        const idA = extractVideoId(urlA);
        const idB = extractVideoId(urlB);
        const idxA = videoIndexes[idA] || { windowId: 0, tabIndex: 99999 };
        const idxB = videoIndexes[idB] || { windowId: 0, tabIndex: 99999 };
        if (idxA.windowId !== idxB.windowId) return idxA.windowId - idxB.windowId;
        return idxA.tabIndex - idxB.tabIndex;
      });
    }

    lastKnownState = {
      tabVideo,
      isRecording,
      recordedVideos: sortedVideos,
      videoReferers: videoReferers || {},
      videoTitles: videoTitles || {},
      videoIndexes: videoIndexes || {},
      history
    };

    updateProfileUI();

    if (isRecording) {
      statusDot.className = "status-dot recording";
      statusText.textContent = `Recording (${lastKnownState.recordedVideos.length} found)`;
      recordBtn.textContent = "Stop Batch & Copy";
      recordBtn.className = "btn primary recording";
    } else {
      statusDot.className = "status-dot";
      statusText.textContent = lastKnownState.recordedVideos.length > 0
        ? `Recording stopped (${lastKnownState.recordedVideos.length} total)`
        : "Idle";
      recordBtn.textContent = "Start Batch Capture";
      recordBtn.className = "btn primary";
    }

    syncQueue(lastKnownState.recordedVideos);
    renderQueue();
    renderBulkCommand();
    renderTabVideo(lastKnownState.tabVideo, history);
    renderStats(lastKnownState.recordedVideos, history);
  } catch (error) {
    handleError("Failed to load extension state", error);
  } finally {
    updateInFlight = false;
    if (needsRefreshAfterCurrent) {
      needsRefreshAfterCurrent = false;
      updateUI().catch((error) => handleError("Failed to refresh UI", error));
    }
  }
}

function renderTabVideo(video, history = []) {
  if (!video) {
    content.textContent = "";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No Vimeo videos detected on this tab.";
    content.appendChild(p);
    clearTabBtn.classList.add("hidden");
    return;
  }

  clearTabBtn.classList.remove("hidden");
  content.textContent = "";

  const card = document.createElement("div");
  card.className = "video-card";

  const referer = video.referer || "";
  const cmd = buildYtDlpCommand([video.url], { referer });
  const isCopied = history.includes(video.videoId);

  const metaRow = document.createElement("div");
  metaRow.className = "video-meta-row";

  const titleDiv = document.createElement("div");
  titleDiv.className = "video-title";
  titleDiv.style.fontWeight = "500";
  titleDiv.style.marginBottom = "4px";
  titleDiv.style.overflow = "hidden";
  titleDiv.style.textOverflow = "ellipsis";
  titleDiv.style.whiteSpace = "nowrap";
  titleDiv.textContent = video.title || "Unknown Page";
  
  const idDiv = document.createElement("div");
  idDiv.className = "video-id";
  idDiv.textContent = `ID: ${video.videoId}`;
  
  if (isCopied) {
    const historyTag = document.createElement("span");
    historyTag.className = "history-tag";
    historyTag.textContent = "✓ Copied";
    idDiv.appendChild(document.createTextNode(" "));
    idDiv.appendChild(historyTag);
  }

  metaRow.appendChild(titleDiv);
  metaRow.appendChild(idDiv);

  const cmdRow = document.createElement("div");
  cmdRow.className = "cmd-row";
  
  const cmdBox = document.createElement("div");
  cmdBox.className = "cmd-box";
  cmdBox.textContent = cmd;

  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.title = "Copy command";
  btn.textContent = "📋";

  cmdRow.appendChild(cmdBox);
  cmdRow.appendChild(btn);

  card.appendChild(metaRow);
  card.appendChild(cmdRow);

  btn.addEventListener("click", async () => {
    try {
      await copyToClipboard(cmd, btn);
      await addToHistory(video.videoId);
      trackProfileUsage(selectedProfileKey);
      renderStats(lastKnownState.recordedVideos, await getCopiedHistory());
    } catch (error) {
      handleError("Failed to copy current tab command", error);
    }
  });

  content.appendChild(card);
}

async function onRecordButtonClick() {
  try {
    const response = await browser.runtime.sendMessage({ type: "getVideos" });
    if (response.isRecording) {
      await browser.runtime.sendMessage({ type: "stopRecording" });
      await updateUI();

      const selectedEntries = getActiveQueueEntries();
      if (selectedEntries.length === 0) {
        showMessage("No selected queue items to copy.", "error");
        return;
      }

      const cmdText = bulkCmdBox.textContent;
      if (cmdText && cmdText !== "yt-dlp ...") {
        await copyToClipboard(cmdText, recordBtn);
        const videoIds = selectedEntries.map((entry) => entry.id);
        await addToHistory(videoIds);
        lastBulkActionCapturedCount = getQueueEntries().length;
        trackProfileUsage(selectedProfileKey);
        await updateUI();

        const origText = recordBtn.textContent;
        recordBtn.textContent = "Copied All!";
        recordBtn.style.background = "#10b981";
        setTimeout(() => {
          recordBtn.textContent = origText;
          recordBtn.style.background = "";
        }, 1800);
      }
    } else {
      await browser.runtime.sendMessage({ type: "startRecording" });
      excludedQueueIds.clear();
      selectedQueueIds = new Set();
      queueOrderIds = [];
      queueUrlById = {};
      lastBulkActionCapturedCount = 0;
      await updateUI();
    }
  } catch (error) {
    handleError("Failed to toggle recording", error);
  }
}

async function onClearBulkClick() {
  try {
    await browser.runtime.sendMessage({ type: "clearRecording" });
    excludedQueueIds.clear();
    selectedQueueIds = new Set();
    queueOrderIds = [];
    queueUrlById = {};
    lastBulkActionCapturedCount = 0;
    await updateUI();
  } catch (error) {
    handleError("Failed to clear captured list", error);
  }
}

async function onClearTabClick() {
  try {
    await browser.runtime.sendMessage({ type: "clearTabVideo" });
    await updateUI();
  } catch (error) {
    handleError("Failed to clear tab video", error);
  }
}

async function onBulkCopyClick() {
  const selectedEntries = getActiveQueueEntries();
  if (selectedEntries.length === 0) {
    showMessage("Select at least one queue item first.", "error");
    return;
  }

  try {
    await copyToClipboard(bulkCmdBox.textContent, bulkCopyBtn);
    await addToHistory(selectedEntries.map((entry) => entry.id));
    lastBulkActionCapturedCount = getQueueEntries().length;
    trackProfileUsage(selectedProfileKey);
    await updateUI();
  } catch (error) {
    handleError("Failed to copy bulk command", error);
  }
}

async function onBulkExportClick() {
  const selectedEntries = getActiveQueueEntries();
  if (selectedEntries.length === 0) {
    showMessage("Select at least one queue item first.", "error");
    return;
  }

  try {
    const urls = selectedEntries.map((entry) => entry.url);
    const contentText = urls.join("\n");
    const blob = new Blob([contentText], { type: "text/plain;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = "urls.txt";
    a.click();
    URL.revokeObjectURL(blobUrl);

    const origIcon = bulkExportBtn.textContent;
    bulkExportBtn.textContent = "✓";
    bulkExportBtn.style.background = "#10b981";
    setTimeout(() => {
      bulkExportBtn.textContent = origIcon;
      bulkExportBtn.style.background = "#0284c7";
    }, 1500);

    await addToHistory(selectedEntries.map((entry) => entry.id));
    lastBulkActionCapturedCount = getQueueEntries().length;
    trackProfileUsage(selectedProfileKey);
    await updateUI();
  } catch (error) {
    handleError("Failed to export URL file", error);
  }
}

function onQueueSelectAll() {
  getQueueEntries().forEach((entry) => selectedQueueIds.add(entry.id));
  renderQueue();
  renderBulkCommand();
  renderStats(lastKnownState.recordedVideos, lastKnownState.history);
}

function onQueueSelectNone() {
  selectedQueueIds = new Set();
  renderQueue();
  renderBulkCommand();
  renderStats(lastKnownState.recordedVideos, lastKnownState.history);
}

async function onClearHistoryClick() {
  try {
    const now = Date.now();
    await browser.storage.local.set({ copiedHistory: [] });
    await browser.runtime.sendMessage({ type: "resetSession" });
    sessionStartedAt = now;
    await updateUI();
    showMessage("Download history cleared.", "success");
  } catch (error) {
    handleError("Failed to clear download history", error);
  }
}

function trackProfileUsage(profileKey) {
  if (!Object.prototype.hasOwnProperty.call(profileUsageCounts, profileKey)) return;
  profileUsageCounts[profileKey] += 1;
}

function getCopiedHistory() {
  return browser.storage.local
    .get("copiedHistory")
    .then((res) => res.copiedHistory || []);
}

function addToHistory(urlsOrIds) {
  return getCopiedHistory().then((history) => {
    const items = Array.isArray(urlsOrIds) ? urlsOrIds : [urlsOrIds];
    items.forEach((item) => {
      if (!history.includes(item)) history.push(item);
    });
    return browser.storage.local.set({ copiedHistory: history });
  });
}

function copyToClipboard(text, button) {
  return navigator.clipboard.writeText(text).then(() => {
    const origIcon = button.textContent;
    button.textContent = "✓";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = origIcon;
      button.classList.remove("copied");
    }, 1500);
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
