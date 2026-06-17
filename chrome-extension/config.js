/**
 * Config-page entry point. Mounts the connect panel (which reads
 * saved-connections from chrome.storage.session and renders the form);
 * on Connect, persists the chosen config as the "active" connection and
 * navigates the window to inspector.html, where the inspector picks it up.
 */

import * as connectPanel from "./panels/connect-panel.js";
import { setActive } from "./lib/saved-connections.js";

document.addEventListener("DOMContentLoaded", () => {
    connectPanel.show({ seed: {}, onConnect: handleConnect });
});

async function handleConnect(config) {
    await setActive(config);
    window.location.href = "inspector.html";
}
