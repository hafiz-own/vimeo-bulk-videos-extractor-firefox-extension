# Vimeo Network Interceptor & yt-dlp Generator

A high-performance Chrome extension for power users that intercepts buried Vimeo players at the network level. 

This extension **does not** download videos for you. Instead, it surgically extracts hidden Vimeo IDs that are obfuscated in the DOM (such as dynamically injected iframes or encrypted players) by sniffing raw `chrome.webRequest` traffic, and instantly generates batched `yt-dlp` commands for terminal execution.

## Power Features
* **Network-Level Interception**: Completely bypasses heavily obfuscated or encrypted DOMs. If the browser makes a request to a Vimeo player, this extension catches it.
* **Chronological Tab Sorting**: Completely immune to middle-click asynchronous race conditions. The extension queries the physical `tab.index` of your browser window to guarantee that bulk exports perfectly match the chronological order of your tabs, regardless of network response times.
* **Context Extraction**: Extracts the `tab.title` and appends it to the export queue, providing crucial context when mapping hundreds of extracted links to a structured curriculum.
* **Storage Debouncing**: Features a high-performance state manager that batches `chrome.storage.local` API calls. You can open 50 background tabs simultaneously without thrashing the browser's hard-drive I/O.
* **Batch yt-dlp Export**: Generates a massive, perfectly ordered `yt-dlp` bash command in a single click, ready to be pasted directly into a headless terminal or exported to a `urls.txt` file.

## Installation for Firefox

1. Clone or download this repository.
2. Open Mozilla Firefox and navigate to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...**
4. Select the `manifest.json` file inside this directory.

## Repository Structure

```text
├── README.md                 # Project documentation
├── manifest.json             # Chrome extension manifest (V3)
├── assets/                   
│   └── icon.svg              # Extension branding
└── src/                      
    ├── background/           
    │   └── background.js     # Service worker (intercepts requests & debounces storage)
    ├── popup/                
    │   ├── popup.html        # Main extension UI
    │   ├── popup.css         # Styling
    │   └── popup.js          # UI logic and yt-dlp command generation
    └── sidebar/              
        └── sidebar.html      # Optional Chrome SidePanel support
```

## Usage Workflow
1. Click the extension icon and select **Start Recording**.
2. Middle-click (or navigate through) any pages containing embedded, obfuscated Vimeo videos.
3. The extension intercepts the background network requests, matches the Video IDs, captures the page title, and sorts them chronologically by tab index.
4. Click **Copy Bulk Command** to instantly grab the batched `yt-dlp` string for your terminal!
