const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

var EXPORTED_SYMBOLS = ["CCK2"];

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
try {
  Cu.import("resource://gre/modules/Timer.jsm");  
} catch (ex) {
  Cu.import("resource://cck2/Timer.jsm");  
}
Cu.import("resource://cck2/Preferences.jsm");
Cu.import("resource://cck2/CTPPermissions.jsm");
Cu.import("resource://cck2/CAPSClipboard.jsm");
Cu.import("resource://cck2/CAPSCheckLoadURI.jsm");
Cu.import("resource:///modules/distribution.js");

XPCOMUtils.defineLazyServiceGetter(this, "bmsvc",
    "@mozilla.org/browser/nav-bookmarks-service;1", "nsINavBookmarksService");
XPCOMUtils.defineLazyServiceGetter(this, "annos",
    "@mozilla.org/browser/annotation-service;1", "nsIAnnotationService");
XPCOMUtils.defineLazyServiceGetter(this, "override",
    "@mozilla.org/security/certoverride;1", "nsICertOverrideService");
XPCOMUtils.defineLazyServiceGetter(this, "uuid",
    "@mozilla.org/uuid-generator;1", "nsIUUIDGenerator");

/* Hack to work around bug that AutoConfig is loaded in the wrong charset */
var fixupUTF8 = null;

if ('�'[0] != '�') {
  fixupUTF8 = function(str) {
    if (!str) {
      return null;
    }
    var out, i, len, c;
    var char2, char3;
  
    out = "";
    len = str.length;
    i = 0;
    while(i < len) {
      c = str.charCodeAt(i++);
      switch(c >> 4)
      { 
        case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
          // 0xxxxxxx
          out += str.charAt(i-1);
          break;
        case 12: case 13:
          // 110x xxxx   10xx xxxx
          char2 = str.charCodeAt(i++);
          out += String.fromCharCode(((c & 0x1F) << 6) | (char2 & 0x3F));
          break;
        case 14:
          // 1110 xxxx  10xx xxxx  10xx xxxx
          char2 = str.charCodeAt(i++);
          char3 = str.charCodeAt(i++);
          out += String.fromCharCode(((c & 0x0F) << 12) | ((char2 & 0x3F) << 6) | ((char3 & 0x3F) << 0));  
          break;
      }
    }
  
    return out;
  };
} else {
  fixupUTF8 = function(str) { return str };
}

/* Crazy hack to work around distribution.ini bug */
/* Basically if the distribution can't be parsed,  make it null */
let dirSvc = Cc["@mozilla.org/file/directory_service;1"].
             getService(Ci.nsIProperties);
let iniFile = dirSvc.get("XREExeF", Ci.nsIFile);
iniFile.leafName = "distribution";
iniFile.append("distribution.ini");
if (iniFile.exists()) {
  try {
    let ini = Cc["@mozilla.org/xpcom/ini-parser-factory;1"].
                 getService(Ci.nsIINIParserFactory).
                 createINIParser(iniFile);
  } catch (e) {
    DistributionCustomizer.prototype.__defineGetter__("_iniFile", function() null);
  }
}

var networkPrefMapping = {
  proxyType: "network.proxy.type",
  proxyHTTP: "network.proxy.http",
  proxyHTTPPort: "network.proxy.http_port",
  proxySSL: "network.proxy.ssl",
  proxySSLPort: "network.proxy.ssl_port",
  proxyFTP: "network.proxy.ftp",
  proxyFTPPort: "network.proxy.ftp_port",
  proxySOCKS: "network.proxy.socks",
  proxySOCKSPort: "network.proxy.socks_port",
  proxySocksVersion: "network.proxy.socks_version",
  proxyNone: "network.proxy.no_proxies_on",
  proxyAutoConfig: "network.proxy.autoconfig_url",
  shareAllProxies: "network.proxy.share_proxy_settings",
  proxySOCKSRemoteDNS: "network.proxy.socks_remote_dns",
  proxyAutologin: "signon.autologin.proxy"
}


function alert(string) {
  Services.prompt.alert(Services.wm.getMostRecentWindow("navigator:browser"), "", string);
} 

var CCK2 = {
  configs: {},
  firstrun: false,
  upgrade: false,
  installedVersion: null,
  initialized: false,
  aboutFactories: [],
  init: function(config) {
    try {
      for (var id in this.configs) {
        if (id == config.id) {
          // We've already processed this config
          return;
        }
      }
      if (!config) {
        // Try to get config from default preference. If it is there, default
        // preference always wins
        var configJSON = Preferences.defaults.get("extensions.cck2.config");
        if (!configJSON) {
          configJSON = Preferences.defaults.get("extensions.cck2.config");
        }
        if (!configJSON) {
          // Try something else. Grou policy?
        }
        try {
          config = JSON.parse(configJSON);
        } catch (ex) {
          return;
        }
      }
  
      // We don't handle in content preferences right now, so make sure they
      // can't be used. We redirect this to an invalid about: page so
      // it doesn't look like the admin disabled it.
      Preferences.lock("browser.preferences.inContent", false);
      var aboutPreferences = {};
      aboutPreferences.classID = Components.ID(uuid.generateUUID().toString());
      aboutPreferences.factory = disableAbout(aboutPreferences.classID,
                                              "",
                                              "preferences");
      CCK2.aboutFactories.push(aboutPreferences);
  
      if (!config)
        return;
      if (!config.id) {
        alert("Missing ID in config");
      }
      config.firstrun = Preferences.get("extensions.cck2." + config.id + ".firstrun", true);
      Preferences.set("extensions.cck2." + config.id + ".firstrun", false);
      if (!config.firstrun) {
        config.installedVersion = Preferences.get("extensions.cck2." + config.id + ".installedVersion");
        config.upgrade = (config.installedVersion != config.version);
      }
      Preferences.set("extensions.cck2." + config.id + ".installedVersion", config.version);
      Preferences.lock("distribution.id", config.id);
      Preferences.lock("distribution.version", config.version + " (CCK2)");
//      Preferences.lock("distribution.about", String(config.id + " - " + config.version + " (CCK2)"));

      if (config.noAddonCompatibilityCheck) {
        Preferences.reset("extensions.lastAppVersion");
      }
      if (config.preferences) {
        for (var i in config.preferences) {
          // Ugly, but we need special handling for this pref
          // since Firefox doesn't honor the default pref
          // So we set a regular pref if first run
          if (i == "plugin.disable_full_page_plugin_for_types") {
            if (this.firstrun) {
              Preferences.set(i, config.preferences[i].value);
            }
            continue;
          }
          // Workaround bug where this pref is coming is as a string from import
          if (i == "toolkit.telemetry.prompted") {
            config.preferences[i].value = parseInt(config.preferences[i].value);
          }
          if (config.preferences[i].locked) {
            Preferences.lock(i, config.preferences[i].value);
          } else {
            if (Preferences.defaults.has(i)) {
              try {
                // If it's a complex preference, we need to set it differently
                Services.prefs.getComplexValue(i, Ci.nsIPrefLocalizedString).data;
                Preferences.defaults.set(i, "data:text/plain," + i + "=" + config.preferences[i].value);
              } catch (ex) {
                Preferences.defaults.set(i, config.preferences[i].value);
              }
            } else {
              Preferences.defaults.set(i, config.preferences[i].value);
            }
          }
        }
      }
      if (config.registry && "@mozilla.org/windows-registry-key;1" in Cc) {
        for (var i in config.registry) {
          addRegistryKey(config.registry[i].rootkey,
                         config.registry[i].key,
                         config.registry[i].name,
                         config.registry[i].value,
                         config.registry[i].type);
        }
      }
      if (config.permissions) {
        for (var i in config.permissions) {
          for (var j in config.permissions[i]) {
            Services.perms.add(NetUtil.newURI("http://" + i), j, config.permissions[i][j]);
            if (j == "plugins") {
              var plugins = Cc["@mozilla.org/plugin/host;1"].getService(Ci.nsIPluginHost).getPluginTags({});
              for (var k=0; k < plugins.length; k++) {
                Services.perms.add(NetUtil.newURI("http://" + i), "plugin:" + CTP.getPluginPermissionFromTag(plugins[k]), config.permissions[i][j]);
                Services.perms.add(NetUtil.newURI("http://" + i), "plugin-vulnerable:" + CTP.getPluginPermissionFromTag(plugins[k]), config.permissions[i][j]);
              }
            }
            // This is a crazy hack to work around bug 1083637
            if (i == "addons.mozilla.org") {
              Preferences.defaults.set("xpinstall.whitelist.add", "");
            }
            if (i == "marketplace.firefox.com") {
              Preferences.defaults.set("xpinstall.whitelist.add.180", "");
            }
          }
          if (Object.keys(config.permissions[i]).length === 0) {
            let perms = Services.perms.enumerator;
            while (perms.hasMoreElements()) {
              let perm = perms.getNext();
              if (perm.host == i) {
                Services.perms.remove(perm.host, perm.type);
              }
            }
          }
        }
      }
      if (config.disablePrivateBrowsing) {
        Preferences.lock("browser.taskbar.lists.tasks.enabled", false);
        Preferences.lock("browser.privatebrowsing.autostart", false);
        var aboutPrivateBrowsing = {};
        aboutPrivateBrowsing.classID = Components.ID(uuid.generateUUID().toString());
        aboutPrivateBrowsing.factory = disableAbout(aboutPrivateBrowsing.classID,
                                                "Disable about:privatebrowsing - CCK",
                                                "privatebrowsing");
        CCK2.aboutFactories.push(aboutPrivateBrowsing);
      }
      if (config.noGetAddons) {
        Preferences.lock("extensions.getAddons.showPane", false);
      }
      if (config.noAddons) {
        Preferences.lock("xpinstall.enabled", false);
      }
      if (config.disablePDFjs) {
        Preferences.lock("pdfjs.disabled", true);
      }
      if (config.disableSync) {
        var aboutAccounts = {};
        aboutAccounts.classID = Components.ID(uuid.generateUUID().toString());
        aboutAccounts.factory = disableAbout(aboutAccounts.classID,
                                                "Disable about:accounts - CCK",
                                                "accounts");
        CCK2.aboutFactories.push(aboutAccounts);
        var aboutSyncLog = {};
        aboutSyncLog.classID = Components.ID(uuid.generateUUID().toString());
        aboutSyncLog.factory = disableAbout(aboutSyncLog.classID,
                                                "Disable about:sync-log - CCK",
                                                "sync-log");
        CCK2.aboutFactories.push(aboutSyncLog);
        var aboutSyncProgress = {};
        aboutSyncProgress.classID = Components.ID(uuid.generateUUID().toString());
        aboutSyncProgress.factory = disableAbout(aboutSyncProgress.classID,
                                                "Disable about:sync-progress - CCK",
                                                "sync-progress");
        CCK2.aboutFactories.push(aboutSyncProgress);
        var aboutSyncTabs = {};
        aboutSyncTabs.classID = Components.ID(uuid.generateUUID().toString());
        aboutSyncTabs.factory = disableAbout(aboutSyncTabs.classID,
                                                "Disable about:sync-tabs - CCK",
                                                "sync-tabs");
        CCK2.aboutFactories.push(aboutSyncTabs);
        Preferences.lock("browser.syncPromoViewsLeftMap", JSON.stringify({bookmarks:0, passwords:0, addons:0}));
      }
      var disableAboutConfigFactory = null;
      if (config.disableAboutConfig) {
        var aboutConfig = {};
        aboutConfig.classID = Components.ID(uuid.generateUUID().toString());
        aboutConfig.factory = disableAbout(aboutConfig.classID,
                                                "Disable about:config - CCK",
                                                "config");
        CCK2.aboutFactories.push(aboutConfig);
      }
      if (config.disableAddonsManager) {
        var aboutAddons = {};
        aboutAddons.classID = Components.ID(uuid.generateUUID().toString());
        aboutAddons.factory = disableAbout(aboutAddons.classID,
                                                "Disable about:addons - CCK",
                                                "addons");
        CCK2.aboutFactories.push(aboutAddons);
      }

      if (config.alwaysDefaultBrowser) {
        var shellSvc = Cc["@mozilla.org/browser/shell-service;1"].getService(Ci.nsIShellService);
        if (shellSvc) {
          try {
            shellSvc.setDefaultBrowser(true, false);
          } catch (e) {
            // setDefaultBrowser errors on Yosemite, so we're just ignoring the error.
            // See Bugzilla bug #1063529
          }
        }
      }
      if (config.dontCheckDefaultBrowser) {
        Preferences.lock("browser.shell.checkDefaultBrowser", false);
      }
      if (config.dontUseDownloadDir) {
        Preferences.lock("browser.download.useDownloadDir", false);
      }
      if (config.disableFormFill) {
        Preferences.lock("browser.formfill.enable", false);
      }
      if (config.removeSmartBookmarks) {
        Preferences.lock("browser.places.smartBookmarksVersion", -1);
      }
      if (config.disableCrashReporter) {
        Preferences.lock("toolkit.crashreporter.enabled", false);
        Cc["@mozilla.org/toolkit/crash-reporter;1"].
          getService(Ci.nsICrashReporter).submitReports = false;
        var aboutCrashes = {};
        aboutCrashes.classID = Components.ID(uuid.generateUUID().toString());
        aboutCrashes.factory = disableAbout(aboutCrashes.classID,
                                                "Disable about:crashes - CCK",
                                                "crashes");
        CCK2.aboutFactories.push(aboutCrashes);
      }
      if (config.disableTelemetry) {
        Preferences.lock("toolkit.telemetry.enabled", false);
        Preferences.lock("toolkit.telemetry.prompted", 2);
        var aboutTelemetry = {};
        aboutTelemetry.classID = Components.ID(uuid.generateUUID().toString());
        aboutTelemetry.factory = disableAbout(aboutTelemetry.classID,
                                                "Disable about:telemetry - CCK",
                                                "telemetry");
        CCK2.aboutFactories.push(aboutTelemetry);
      }
      if (config.removeDeveloperTools) {
        Preferences.lock("devtools.scratchpad.enabled", false);
        Preferences.lock("devtools.responsiveUI.enabled", false);
        Preferences.lock("devtools.toolbar.enabled", false);
        Preferences.lock("devtools.styleeditor.enabled", false);
        Preferences.lock("devtools.debugger.enabled", false);
        Preferences.lock("devtools.profiler.enabled", false);
        Preferences.lock("devtools.errorconsole.enabled", false);
        Preferences.lock("devtools.inspector.enabled", false);
      }
      if (config.homePage && !config.lockHomePage) {
        Preferences.defaults.set("browser.startup.homepage", "data:text/plain,browser.startup.homepage=" + config.homePage);
        /* If you have a distribution.ini, browser.startup.homepage gets wiped out */
        /* We need to save it */
        if (!Preferences.isSet("browser.startup.homepage")) {
          Preferences.set("browser.startup.homepage", config.homePage);
        }
      }
      if (config.lockHomePage) {
        if (config.homePage) {
          Preferences.lock("browser.startup.homepage", config.homePage);
        } else {
          Preferences.lock("browser.startup.homepage");
        }
        Preferences.lock("pref.browser.homepage.disable_button.current_page", true);
        Preferences.lock("pref.browser.homepage.disable_button.bookmark_page", true);
        Preferences.lock("pref.browser.homepage.disable_button.restore_default", true);
      }
      if (config.noWelcomePage) {
        Preferences.lock("startup.homepage_welcome_url", "");
      } else if (config.welcomePage) {
        Preferences.lock("startup.homepage_welcome_url", config.welcomePage);
      }
      if (config.noUpgradePage) {
        Preferences.lock("browser.startup.homepage_override.mstone", "ignore");
      } else if (config.upgradePage) {
        Preferences.lock("startup.homepage_override_url", config.upgradePage);
      }
      if (config.dontShowRights) {
        Preferences.lock("browser.rights.override", true);
      }
      if (config.dontRememberPasswords) {
        Preferences.lock("signon.rememberSignons", false);
      }
      if (config.disableFirefoxHealthReport) {
        Preferences.lock("datareporting.healthreport.uploadEnabled", false);
        var aboutHealthReport = {};
        aboutHealthReport.classID = Components.ID(uuid.generateUUID().toString());
        aboutHealthReport.factory = disableAbout(aboutHealthReport.classID,
                                                "Disable about:healthreport - CCK",
                                                "healthreport");
        CCK2.aboutFactories.push(aboutHealthReport);
      }
      if (config.disableFirefoxHealthReportUpload) {
        Preferences.lock("datareporting.healthreport.uploadEnabled", false);
      }
      if (config.disableResetFirefox) {
        try {
          Cu.import("resource:///modules/UITour.jsm");
          UITour.origOnPageEvent = UITour.onPageEvent;
          UITour.onPageEvent = function(a, b) {
            var aEvent = b;
            if (!aEvent) {
              aEvent = a;
            }
            if (aEvent.detail.action == "resetFirefox") {
              Services.prompt.alert(null, "CCK2", "This has been disabled by your administrator");
              return;
            }
            UITour.origOnPageEvent(a, b);
          }
        } catch (e) {}
      }
      if (config.disableFirefoxUpdates) {
        Preferences.lock("app.update.auto", false);
        Preferences.lock("app.update.enabled", false);
      }
      if (config.network) {
        for (var i in networkPrefMapping) {
          if (i in config.network) {
            Preferences.defaults.set(networkPrefMapping[i], config.network[i]);
          }
          if (config.network.locked) {
            Preferences.lock(networkPrefMapping[i]);
          }
        }
      }
      // Fixup bad strings
      if ("helpMenu" in config) {
        if ("label" in config.helpMenu) {
          config.helpMenu.label = fixupUTF8(config.helpMenu.label);
        }
        if ("accesskey" in config.helpMenu) {
          config.helpMenu.accesskey = fixupUTF8(config.helpMenu.accesskey);
        }
      }
      if ("titlemodifier" in config) {
        config.titlemodifier = fixupUTF8(config.titlemodifier);
      }
      if ("defaultSearchEngine" in config) {
        config.defaultSearchEngine = fixupUTF8(config.defaultSearchEngine);
      }
      this.configs[config.id] = config;
    } catch (e) {
      errorCritical(e);
    }
  },
  getConfigs: function() {
    return this.configs;
  },
  observe: function observe(subject, topic, data) {
    switch (topic) {
      case "distribution-customization-complete":
        for (var id in this.configs) {
          var config = this.configs[id];
          // Due to bug 947838, we have to reinitialize default preferences
          {
            var iniFile = Services.dirsvc.get("XREExeF", Ci.nsIFile);
            iniFile.leafName = "distribution";
            iniFile.append("distribution.ini");
            if (iniFile.exists()) {
              if (config.preferences) {
                for (var i in config.preferences) {
                  // Ugly, but we need special handling for this pref
                  // since Firefox doesn't honor the default pref
                  if (i == "plugin.disable_full_page_plugin_for_types") {
                    continue;
                  }
                  // Workaround bug where this pref is coming is as a string from import
                  if (i == "toolkit.telemetry.prompted") {
                     config.preferences[i].value = parseInt(config.preferences[i].value);
                  }
                  if (!("locked" in config.preferences[i])) {
                    if (Preferences.defaults.has(i)) {
                      try {
                        // If it's a complex preference, we need to set it differently
                        Services.prefs.getComplexValue(i, Ci.nsIPrefLocalizedString).data;
                        Preferences.defaults.set(i, "data:text/plain," + i + "=" + config.preferences[i].value);
                      } catch (ex) {
                        Preferences.defaults.set(i, config.preferences[i].value);
                      }
                    } else {
                      Preferences.defaults.set(i, config.preferences[i].value);
                    }
                  }
                }
              }
            }
            if (config.homePage && !config.lockHomePage) {
              Preferences.defaults.set("browser.startup.homepage", "data:text/plain,browser.startup.homepage=" + config.homePage);
              /* If you have a distribution.ini, we changed browser.startup.homepage */
              /* Put it back */
              if (Preferences.get("browser.startup.homepage") == config.homePage) {
                Preferences.reset("browser.startup.homepage");
              }
            }
            if (config.network) {
              for (var i in networkPrefMapping) {
                if (i in config.network) {
                  Preferences.defaults.set(networkPrefMapping[i], config.network[i]);
                }
              }
            }
          }
          // Try to install devices every time just in case get added after install
          if ("certs" in config && "devices" in config.certs) {
            var pkcs11 = Components.classes["@mozilla.org/security/pkcs11;1"].getService(Ci.nsIPKCS11);
            for (var i=0; i < config.certs.devices.length; i++) {
              var file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
              try {
                file.initWithPath(config.certs.devices[i].path);
                if (file.exists()) {
                  pkcs11.addModule(config.certs.devices[i].name, config.certs.devices[i].path, 0, 0);
                }
              } catch(e) {
                // Ignore path errors in case we are on different OSes
              }
            }
          }
          if (!config.firstrun && config.installedVersion == config.version) {
            continue;
          }
          if ("certs" in config) {
            if ("override" in config.certs) {
              for (var i=0; i < config.certs.override.length; i++) {
                var xhr = Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance();
                try {
                  xhr.open("GET", "https://" + config.certs.override[i]);
                  xhr.channel.notificationCallbacks = SSLExceptions;
                  xhr.send(null);
                } catch (ex) {}
              }
            }
            var certdb = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB);
            var certdb2 = certdb;
            try {
              certdb2 = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB2);
            } catch (e) {
            }
            if (config.certs.ca) {
              for (var i=0; i < config.certs.ca.length; i++) {
                var certTrust;
                if (config.certs.ca[i].trust){
                  certTrust = config.certs.ca[i].trust
                } else {
                  certTrust = "C,C,C";
                }
                if (config.certs.ca[i].url) {
                  try {
                    download(config.certs.ca[i].url, function(file, extraParams) {
                      var istream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
                      istream.init(file, -1, -1, false);
                      var bstream = Components.classes["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
                      bstream.setInputStream(istream);
                      var cert = bstream.readBytes(bstream.available());
                      bstream.close();
                      istream.close();
                      if (/-----BEGIN CERTIFICATE-----/.test(cert)) {
                        certdb2.addCertFromBase64(fixupCert(cert), extraParams.trust, "");
                      } else {
                        certdb.addCert(cert, extraParams.trust, "");
                      }
                    }, errorCritical, {trust: certTrust});
                  } catch (e) {
                    errorCritical("Unable to install " + config.certs.ca[i].url);
                  }
                } else if (config.certs.ca[i].cert) {
                  certdb2.addCertFromBase64(fixupCert(config.certs.ca[i].cert), certTrust, "");
                }
              }
            }
            if (config.certs.server) {
              for (var i=0; i < config.certs.server.length; i++) {
                try {
                  download(config.certs.server[i], function(file) {
                    certdb.importCertsFromFile(null, file, Ci.nsIX509Cert.SERVER_CERT);
                  }, errorCritical);
                } catch (e) {
                  errorCritical("Unable to install " + config.certs.server[i]);
                }
              }
            }
          }
          if (config.removeSmartBookmarks) {
            var smartBookmarks = annos.getItemsWithAnnotation("Places/SmartBookmark", {});
            for (var i = 0; i < smartBookmarks.length; i++) {
              try {
                bmsvc.removeItem(smartBookmarks[i]);
              } catch (ex) {}
            }
          }
          if (config.removeDefaultBookmarks) {
            var firefoxFolder = bmsvc.getIdForItemAt(bmsvc.bookmarksMenuFolder, 3);
            if ((firefoxFolder != -1) && (bmsvc.getItemType(firefoxFolder) == bmsvc.TYPE_FOLDER)) {
              var aboutMozilla = bmsvc.getIdForItemAt(firefoxFolder, 3);
              if (aboutMozilla != -1 &&
                  bmsvc.getItemType(aboutMozilla) == bmsvc.TYPE_BOOKMARK &&
                  /https?:\/\/www.mozilla.(com|org)\/.*\/about/.test(bmsvc.getBookmarkURI(aboutMozilla).spec)) {
                bmsvc.removeItem(firefoxFolder);
              }
            }
            var userAgentLocale = Preferences.defaults.get("general.useragent.locale");
            var gettingStartedURL = "https://www.mozilla.org/" + userAgentLocale + "/firefox/central/";
            var bookmarks = bmsvc.getBookmarkIdsForURI(NetUtil.newURI("https://www.mozilla.org/" + userAgentLocale + "/firefox/central/"));
            if (bookmarks.length == 0) {
              bookmarks = bmsvc.getBookmarkIdsForURI(NetUtil.newURI("http://www.mozilla.com/" + userAgentLocale + "/firefox/central/"));
            }
            if (bookmarks.length > 0) {
              bmsvc.removeItem(bookmarks[0])
            }
            var bookmarks = bmsvc.getBookmarkIdsForURI(NetUtil.newURI("https://www.mozilla.org/" + userAgentLocale + "/about/"));
            if (bookmarks.length == 0) {
              bookmarks = bmsvc.getBookmarkIdsForURI(NetUtil.newURI("http://www.mozilla.com/" + userAgentLocale + "/about/"));
            }
            if (bookmarks.length > 0) {
              var mozillaFolder = bmsvc.getFolderIdForItem(bookmarks[0]);
              if (mozillaFolder != -1) {
                var mozillaFolderIndex = bmsvc.getItemIndex(mozillaFolder);
                var mozillaFolderParent = bmsvc.getFolderIdForItem(mozillaFolder);
                bmsvc.removeItem(mozillaFolder);
                if (config.removeSmartBookmarks) {
                  var separator = bmsvc.getIdForItemAt(mozillaFolderParent, mozillaFolderIndex-1);
                  if (separator != -1) {
                    bmsvc.removeItem(separator);
                  }
                }
              }
            }
          }

          // If we detect an old CCK Wizard, remote it's bookmarks
          var oldCCKVersion = Preferences.get("extensions." + config.extension.id + ".version", null);
          if (oldCCKVersion) {
            Preferences.reset("extensions." + config.extension.id + ".version");
            var oldBookmarks = annos.getItemsWithAnnotation(config.extension.id + "/" + oldCCKVersion, {});
            for (var i = 0; i < oldBookmarks.length; i++) {
              try {
                bmsvc.removeItem(oldBookmarks[i]);
              } catch (ex) {}
            }
          }
          if (config.installedVersion != config.version) {
            var oldBookmarks = annos.getItemsWithAnnotation(config.id + "/" + config.installedVersion, {});
            for (var i = 0; i < oldBookmarks.length; i++) {
              try {
                bmsvc.removeItem(oldBookmarks[i]);
              } catch (ex) {}
            }
          }
          if (config.bookmarks) {
            if (config.bookmarks.toolbar) {
              addBookmarks(config.bookmarks.toolbar, bmsvc.toolbarFolder, config.id + "/" + config.version);
            }
            if (config.bookmarks.menu) {
              addBookmarks(config.bookmarks.menu, bmsvc.bookmarksMenuFolder, config.id + "/" + config.version);
            }
          }
          if (config.searchplugins || config.defaultSearchEngine) {
            searchInitRun(function() {
              for (var i in config.searchplugins) {
                var engine = Services.search.getEngineByName(i);
                // Should we remove engines and readd?
                if (!engine) {
                  Services.search.addEngine(config.searchplugins[i], Ci.nsISearchEngine.DATA_XML, null, false, {
                    onSuccess: function (engine) {
                      if (engine.name == config.defaultSearchEngine) {
                        Services.search.currentEngine = engine;
                      }
                    },
                    onError: function (errorCode) {
                      // Ignore errors
                    }
                  });
                }
              }
              var defaultSearchEngine = Services.search.getEngineByName(config.defaultSearchEngine);
              if (defaultSearchEngine) {
                Services.search.currentEngine = defaultSearchEngine;
              }
            });
          }
          if (config.disableSearchEngineInstall) {
            try {
              Cu.import("resource:///modules/ContentLinkHandler.jsm");
              ContentLinkHandler.origOnLinkAdded = ContentLinkHandler.onLinkAdded;
              ContentLinkHandler.onLinkAdded = function(event, chromeGlobal) {
                if (event.originalTarget.rel == "search") {
                  return;
                }
                ContentLinkHandler.origOnLinkAdded(event, chromeGlobal);
              };
            } catch (e) {
              // Just in case we are pre Firefox 31
            }
          }
        }
        break;
      case "browser-ui-startup-complete":
        return;
        try {
          Cu.import("resource://gre/modules/WebappManager.jsm");
        } catch (e) {
          try {
            Cu.import("resource:///modules/WebappManager.jsm");
          } catch (e) {}
        }
        WebappManager.doInstall = function() {
          var win = Services.wm.getMostRecentWindow("navigator:browser");
          var gBrowser = win.gBrowser;
          var gNavigatorBundle = win.gNavigatorBundle
          messageString = gNavigatorBundle.getString("xpinstallDisabledMessageLocked");;
          var options = {
            timeout: Date.now() + 30000
          };
          win.PopupNotifications.show(gBrowser.selectedBrowser, "xpinstall-disabled",
                                      messageString, "addons-notification-icon",
                                      null, null, options);
        };
        break;
      case "final-ui-startup":
//        let globalMM = Cc["@mozilla.org/globalmessagemanager;1"].getService(Ci.nsIMessageListenerManager);
//        globalMM.loadFrameScript("resource://cck2/CAPSClipboard-fs.js", true);
        for (var id in this.configs) {
          var config = this.configs[id];
          if (!config.firstrun && config.installedVersion == config.version) {
            return;
          }
          if (config.addons) {
            Cu.import("resource://gre/modules/AddonManager.jsm");
            var numAddonsInstalled = 0;
            var numAddons = config.addons.length;
            for (var i=0; i < config.addons.length; i++) {
              try {
              AddonManager.getInstallForURL(config.addons[i], function(addonInstall) {
                let listener = {
                  onInstallEnded: function(install, addon) {
                    if (addon.isActive) {
                      // restartless add-on, so we don't need to restart
                      numAddons--;
                    } else {
                      numAddonsInstalled++;
                    }
                    if (numAddonsInstalled > 0 &&
                        numAddonsInstalled == config.addons.length) {
                      Services.startup.quit(Services.startup.eRestart | Services.startup.eAttemptQuit);
                    }
                  }
                }
                addonInstall.addListener(listener);
                addonInstall.install();
              }, "application/x-xpinstall");
              } catch (e) {
                errorCritical(e);
              }
            }
          }
        }
        break;
      case "quit-application":
        var registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
        for (var i=0; i < CCK2.aboutFactories.length; i++)
          registrar.unregisterFactory(CCK2.aboutFactories[i].classID, CCK2.aboutFactories[i].factory);
        break;
    }
  }
}

function addRegistryKey(RootKey, Key, Name, NameValue, Type) {
  const nsIWindowsRegKey = Ci.nsIWindowsRegKey;
  var key = null;

  try {
    key = Cc["@mozilla.org/windows-registry-key;1"]
                .createInstance(nsIWindowsRegKey);
    var rootKey;
    switch (RootKey) {
      case "HKEY_CLASSES_ROOT":
        rootKey = nsIWindowsRegKey.ROOT_KEY_CLASSES_ROOT;
        break;
      case "HKEY_CURRENT_USER":
        rootKey = nsIWindowsRegKey.ROOT_KEY_CURRENT_USER;
        break;
      default:
        rootKey = nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE;
        break;
    }

    key.create(rootKey, Key, nsIWindowsRegKey.ACCESS_WRITE);

    switch (Type) {
      case "REG_DWORD":
        key.writeIntValue(Name, NameValue);
        break;
      case "REG_QWORD":
        key.writeInt64Value(Name, NameValue);
        break;
      case "REG_BINARY":
        key.writeBinaryValue(Name, NameValue);
        break;
      case "REG_SZ":
      default:
        key.writeStringValue(Name, NameValue);
        break;
    }
    key.close();
  } catch (ex) {
    /* This could fail if you don't have the right authority on Windows */
    if (key) {
      key.close();
    }
  }
}

function addBookmarks(bookmarks, destination, annotation) {
  for (var i =0; i < bookmarks.length; i++) {
    if (bookmarks[i].folder) {
      var newFolderId = bmsvc.createFolder(destination, fixupUTF8(bookmarks[i].name), bmsvc.DEFAULT_INDEX);
      annos.setItemAnnotation(newFolderId, annotation, "true", 0, annos.EXPIRE_NEVER);
      addBookmarks(bookmarks[i].folder, newFolderId, annotation);
    } else if (bookmarks[i].type == "separator") {
      bmsvc.insertSeparator(destination, bmsvc.DEFAULT_INDEX);
    } else {
      try {
        var newBookmarkId = bmsvc.insertBookmark(destination, NetUtil.newURI(bookmarks[i].location), bmsvc.DEFAULT_INDEX, fixupUTF8(bookmarks[i].name));
        annos.setItemAnnotation(newBookmarkId, annotation, "true", 0, annos.EXPIRE_NEVER);
      } catch(e) {}
    }
  }
}

function errorCritical(e) {
  var stack = e.stack;
  if (!stack) {
    stack = Error().stack;
  }
  Services.prompt.alert(null, "CCK2", e + "\n\n" + stack);
}

/**
 * If the search service is not available, passing function
 * to search service init
 */
function searchInitRun(func)
{
  if (Services.search.init && !Services.search.isInitialized)
    Services.search.init(func);
  else
    func();
}

/**
 * Check to see if a given cert exists so we don't readd.
 * I'm not convinced this is actually needed, since we don't get errors
 * adding the same cert twice...
 */
function certExists(cert) {
  return false;
  var actualCert = certdb.constructX509FromBase64(fixupCert(cert));
  try {
    var installedCert = certdb.findCertByNickname(null, actualCert.commonName + " - " + actualCert.organization);
    if (installedCert)
      return true;
  } catch(ex) {}
  return false;
}

/**
 * Remove all extraneous info from a certificates. addCertFromBase64 requires
 * just the cert with no whitespace or anything.
 *
 * @param {String} certificate text
 * @returns {String} certificate text cleaned up
 */
function fixupCert(cert) {
  var beginCert = "-----BEGIN CERTIFICATE-----";
  var endCert = "-----END CERTIFICATE-----";

  cert = cert.replace(/[\r\n]/g, "");
  var begin = cert.indexOf(beginCert);
  var end = cert.indexOf(endCert);
  return cert.substring(begin + beginCert.length, end);
}

/**
 * Download the given URL to the user's download directory
 *
 * @param {String} URL of the file
 * @param {function} Function to call on success - called with nsIFile
 * @param {String} Function to call on failure
 * @param {Object} extraParams passed to callback
 * @returns {nsIFile} Downloaded file
 */
function download(url, successCallback, errorCallback, extraParams) {
  var uri = Services.io.newURI(url, null, null);

  var channel = Services.io.newChannelFromURI(uri);

  var downloader = Cc["@mozilla.org/network/downloader;1"].createInstance(Ci.nsIDownloader);
  var listener = {
    onDownloadComplete: function(downloader, request, ctxt, status, result) {
      if (Components.isSuccessCode(status)) {
        result.QueryInterface(Ci.nsIFile);
        if (result.exists() && result.fileSize > 0) {
          successCallback(result, extraParams);
          return;
        }
      }
      errorCallback(new Error("Download failed (" + status + " for " + url));
    }
  }
  downloader.init(listener, null);
  channel.asyncOpen(downloader, null);
}

/**
 * Used to allow the overriding of certificates
 */
var SSLExceptions = {
  getInterface: function(uuid) {
    return this.QueryInterface(uuid);
  },
  QueryInterface: function(uuid) {
    if (uuid.equals(Ci.nsIBadCertListener2) ||
        uuid.equals(Ci.nsISupports))
      return this;
    throw Components.results.NS_ERROR_NO_INTERFACE;
  },

  notifyCertProblem: function (socketInfo, status, targetSite) {
    status.QueryInterface(Ci.nsISSLStatus);

    let flags = 0;

    if (status.isUntrusted)
      flags |= override.ERROR_UNTRUSTED;
    if (status.isDomainMismatch)
      flags |= override.ERROR_MISMATCH;
    if (status.isNotValidAtThisTime)
      flags |= override.ERROR_TIME;

    var hostInfo = targetSite.split(":");

    override.rememberValidityOverride(
      hostInfo[0],
      hostInfo[1],
      status.serverCert,
      flags,
      false);
    return true; // Don't show error UI
  }
};

/**
 * Register a component that replaces an about page
 *
 * @param {String} The ClassID of the class being registered.
 * @param {String} The name of the class being registered.
 * @param {String} The type of about to be disabled (config/addons/privatebrowsing)
 * @returns {Object} The factory to be used to unregister
 */
function disableAbout(aClass, aClassName, aboutType) {
  var gAbout = {
    newChannel : function (aURI) {
      var url = "chrome://cck2/content/about.xhtml";
      if (aboutType == "preferences") {
        url = "about:preferences-no";
      }
      var channel = Services.io.newChannel(url, null, null);
      channel.originalURI = aURI;
      return channel;
    },
    getURIFlags : function getURIFlags(aURI) {
      return Ci.nsIAboutModule.HIDE_FROM_ABOUTABOUT;
    },

    QueryInterface: XPCOMUtils.generateQI([Ci.nsIAboutModule]),

    createInstance: function(outer, iid) {
       return this.QueryInterface(iid);
    },
  };

  var registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  registrar.registerFactory(aClass, aClassName, "@mozilla.org/network/protocol/about;1?what=" + aboutType, gAbout);
  return gAbout;
}

var documentObserver = {
  observe: function observe(subject, topic, data) {
    if (subject instanceof Ci.nsIDOMWindow) {
      var win = subject.QueryInterface(Components.interfaces.nsIDOMWindow);
      if (topic == "chrome-document-global-created" ||
          (topic == "content-document-global-created" && win.document.documentURIObject.scheme == "about")) {
        win.addEventListener("load", function(event) {
          win.removeEventListener("load", arguments.callee, false);
          var doc = event.target;
          var configs = CCK2.getConfigs();
          for (var id in configs) {
            var config = configs[id];
            if (config.hiddenUI) {
              for (var i=0; i < config.hiddenUI.length; i++) {
                var uiElements = doc.querySelectorAll(config.hiddenUI[i]);
                for (var j=0; j < uiElements.length; j++) {
                  var uiElement = uiElements[j];
                  uiElement.setAttribute("hidden", "true");
                }
              }
            }
          }
        }, false);
      }
      if (topic == "content-document-global-created") {
        var configs = CCK2.getConfigs();
        for (var id in configs) {
          var config = configs[id];
          if (config.disableSearchEngineInstall) {
            subject.wrappedJSObject.external.AddSearchProvider = function() {};
          }
        }
      }
    }
  }
}

Services.obs.addObserver(CCK2, "distribution-customization-complete", false);
Services.obs.addObserver(CCK2, "final-ui-startup", false);
Services.obs.addObserver(CCK2, "browser-ui-startup-complete", false);
Services.obs.addObserver(documentObserver, "chrome-document-global-created", false);  
Services.obs.addObserver(documentObserver, "content-document-global-created", false);  
