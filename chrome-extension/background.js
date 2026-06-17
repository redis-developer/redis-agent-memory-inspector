/**
 * Service worker. Single job: on toolbar-icon click, open the configure
 * page in a dedicated popup window. config.html is the entry point;
 * after the user connects it navigates the same window to inspector.html
 * (the inspector). No state lives here across runs.
 */

chrome.action.onClicked.addListener(async () => {
    await chrome.windows.create({
        url: chrome.runtime.getURL("config.html"),
        type: "popup",
        width: 760,
        height: 820,
    });
});
