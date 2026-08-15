/**
 * Zotero PDF Auto Crop — bootstrap 生命周期（Zotero 7+，官方 make-it-red 模式）。
 *
 * 参考：https://www.zotero.org/support/dev/zotero_7_for_developers
 *
 * startup：注册 chrome（content/ 目录，供 standard_fonts 等资源以
 *   chrome://zotero-pdf-auto-crop/content/... 访问），加载构建产物
 *   content/scripts/zotero-pdf-auto-crop.js，调用 hooks。
 * shutdown：卸载菜单等资源；APP_SHUTDOWN 时跳过（Zotero 进程退出）。
 */
var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zotero-pdf-auto-crop", rootURI + "content/"],
  ]);

  var ctx = { rootURI };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    rootURI + "content/scripts/zotero-pdf-auto-crop.js",
    ctx
  );
  await Zotero.ZoteroPdfAutoCrop.hooks.onStartup();
}

async function onMainWindowLoad({ window }, reason) {
  await Zotero.ZoteroPdfAutoCrop?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.ZoteroPdfAutoCrop?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.ZoteroPdfAutoCrop?.hooks.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function uninstall(data, reason) {}
