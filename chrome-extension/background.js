/**
 * Service worker. Single job: on toolbar-icon click, open the inspector in
 * a dedicated popup window. The inspector window owns everything else.
 *
 * No state lives anywhere across runs.
 */

chrome.action.onClicked.addListener(async () => {
    await chrome.windows.create({
        url: chrome.runtime.getURL("index.html"),
        type: "popup",
        width: 760,
        height: 820,
    });
});
