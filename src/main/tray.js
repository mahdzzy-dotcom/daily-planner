'use strict';

// The system tray icon (the little icon near the clock).
// The menu is built from a plain list of actions, so new actions can be added later by adding
// one line to that list.
//
// action: { id, label, click, separatorBefore }

function buildTrayMenuTemplate(actions) {
  const template = [];
  for (const action of actions) {
    if (action.separatorBefore) template.push({ type: 'separator' });
    template.push({ label: action.label, click: action.click });
  }
  return template;
}

// electron: { Tray, Menu, nativeImage }  (passed in so this can be tested without Electron)
function createTray({ Tray, Menu, nativeImage }, { iconPath, tooltip, actions, onOpen }) {
  const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  const tray = new Tray(image);
  tray.setToolTip(tooltip);
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(actions)));

  // Double-click opens the window (spec). A single click does the same, which is what most people try first.
  tray.on('double-click', onOpen);
  tray.on('click', onOpen);

  return {
    tray,
    setActions(newActions) {
      tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(newActions)));
    },
    destroy() {
      if (!tray.isDestroyed || !tray.isDestroyed()) tray.destroy();
    },
  };
}

module.exports = { buildTrayMenuTemplate, createTray };
