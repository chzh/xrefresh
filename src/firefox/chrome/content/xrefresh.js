// we use UTF-8 encoded JSON to exchange messages between extension and server
//
// this source contains copy&pasted various bits from Firebug sources.

// open custom scope
FBL.ns(function() {
    with(FBL) {
        const Cc = Components.classes;
        const Ci = Components.interfaces;

        const xrefreshPrefService =    Cc["@mozilla.org/preferences-service;1"];
        const socketServer =           Cc["@mozilla.org/network/server-socket;1"];
        const socketTransportService = Cc["@mozilla.org/network/socket-transport-service;1"];
        const inputStream =            Cc["@mozilla.org/scriptableinputstream;1"];
        const inputStreamPump =        Cc["@mozilla.org/network/input-stream-pump;1"];
        const localFile =              Cc["@mozilla.org/file/local;1"];
        const fileInputStream =        Cc["@mozilla.org/network/file-input-stream;1"];

        const nsIPrefBranch  = Ci.nsIPrefBranch;
        const nsIPrefBranch2 = Ci.nsIPrefBranch2;

        const xrefreshPrefs = xrefreshPrefService.getService(nsIPrefBranch2);

        const xrefreshHomepage = "http://xrefresh.binaryage.com";

        if (Firebug.TraceModule) {
            Firebug.TraceModule.DBG_XREFRESH = false;
            var type = xrefreshPrefs.getPrefType('extensions.firebug.DBG_XREFRESH');
            if (type != nsIPrefBranch.PREF_BOOL) try {
                xrefreshPrefs.setBoolPref('extensions.firebug.DBG_XREFRESH', false);
            } catch(e) {}
        }

        function dbg() {
            if (FBTrace && FBTrace.DBG_XREFRESH) FBTrace.sysout.apply(this, arguments);
        }

        var optionMenu = function(label, option) {
            return {
                label: label, 
                nol10n: true,
                type: "checkbox", 
                checked: Firebug.XRefresh.getPref(option), 
                option: option,
                command: function() {
                    Firebug.XRefresh.setPref(option, !Firebug.XRefresh.getPref(option)); // toggle
                }
            };
        };
        
        // shortcuts (available in this closure):
        var module;   // <-- here will be stored Firebug.XRefresh singleton (extension module)
        var server;   // <-- here will be stored Firebug.XRefreshServer singleton
        var listener; // <-- here will be stored Firebug.XRefreshListener singleton
        
        ////////////////////////////////////////////////////////////////////////
        // Firebug.XRefreshServer is singleton, it keeps system-wide connection to xrefresh server
        //
        server = Firebug.XRefreshServer = {
            // see http://www.xulplanet.com/tutorials/mozsdk/sockets.php
            transport: null,
            outStream: null,
            inStream: null,
            pump: null,
            ready: false,
            name: '',
            version: '',
            data: '',
            reminder: '',
            /////////////////////////////////////////////////////////////////////////////////////////
            connect: function() {
                dbg(">> XRefreshServer.connect", arguments);

                this.releaseStreams();
                this.data = '';
                this.reminder = '';
                
                var transportService = socketTransportService.getService(Ci.nsISocketTransportService);
                this.transport = transportService.createTransport(null, 0, module.getPref("host"), module.getPref("port"), null);
                this.outStream = this.transport.openOutputStream(0, 0, 0);

                var stream = this.transport.openInputStream(0, 0, 0);
                this.inStream = inputStream.createInstance(Ci.nsIScriptableInputStream);
                this.inStream.init(stream);

                var that = this;
                var listener = {
                    onStartRequest: function(request, context) {
                    },
                    onStopRequest: function(request, context, status) {
                        that.onServerDied();
                    },
                    onDataAvailable: function(request, context, inputStream, offset, count) {
                        that.data += that.inStream.read(count);
                        that.onDataAvailable();
                    }
                };

                this.pump = inputStreamPump.createInstance(Ci.nsIInputStreamPump);
                this.pump.init(stream, -1, -1, 0, 0, false);
                this.pump.asyncRead(listener, null);

                this.sendHello();
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            disconnect: function() {
                dbg(">> XRefreshServer.disconnect", arguments);
                if (this.ready) {
                    module.log("Disconnected from XRefresh Server", "disconnect");
                    // it is nice to say good bye ...
                    this.sendBye();
                    this.ready = false;
                }
                this.releaseStreams();
                module.updatePanels();
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            reconnect: function() {
                dbg(">> XRefreshServer.reconnect", arguments);
                this.disconnect();
                this.connect();
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            releaseStreams: function() {
                if (this.inStream) {
                    this.inStream.close();
                    this.inStream = null;
                }
                if (this.outStream) {
                    this.outStream.close();
                    this.outStream = null;
                }
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            onServerDied: function() {
                dbg(">> XRefreshServer.onServerDied", arguments);
                if (this.ready) {
                    module.error("XRefresh Server has closed connection");
                    this.ready = false;
                }
                this.releaseStreams();
                module.updatePanels();
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            onDataAvailable: function() {
                dbg(">> XRefresh.onDataAvailable", arguments);
                // try to parse incomming message
                // here we expect server to send always valid stream of {json1}\n{json2}\n{json3}\n...
                // TODO: make this more robust to server formating failures
                var data = this.data;
                dbg(data||"empty message");
                var parts = this.data.split('\n');
                var buffer = this.reminder;
                for (var i = 0; i < parts.length; i++) {
                    buffer += UTF8.decode(parts[i]);
                    dbg("  buffer:", buffer);

                    var message = JSON.parse(buffer);
                    if (!message) continue;
                    // we have only partial buffer? go for next chunk
                    buffer = '';
                    // message completed, clear buffer for incomming data
                    dbg("    message:", message);
                    //try {
                        module.processMessage(message);
                    // } catch(e) {
                    //     module.error(listener.context, "Error in processing message from XRefresh Server");
                    // }
                }
                this.reminder = buffer;
                this.data = "";
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            send: function(message) {
                dbg(">> XRefresh.send: "+message.command, arguments);
                if (!this.outStream) {
                    dbg("  !! outStream is null", arguments);
                    return false;
                }
                var data = JSON.stringify(message) + '\n'; // every message is delimited with new line
                var utf8data = UTF8.encode(data);
                this.outStream.write(utf8data, utf8data.length);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            // message helpers
            sendHello: function() {
                var message = {
                    command: "Hello",
                    type: "Firefox",
                    agent: navigator.userAgent.toLowerCase()
                };
                this.send(message);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            sendBye: function() {
                var message = {
                    command: "Bye"
                };
                this.send(message);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            sendSetPage: function(contentTitle, contentURL) {
                var message = {
                    command: "SetPage",
                    page: contentTitle,
                    url: contentURL
                };
                this.send(message);
            }
        };
        
        ////////////////////////////////////////////////////////////////////////
        // listener is singleton, it keeps system-wide listener to xrefresh server boot
        // when server boots, it pings this listener and extension than can attempt to connect using server
        //
        listener = Firebug.XRefreshListener = {
            server: null, // see http://www.xulplanet.com/tutorials/mozsdk/serverpush.php
            /////////////////////////////////////////////////////////////////////////////////////////
            start: function() {
                dbg(">> XRefreshListener.start", arguments);
                var server = socketServer.createInstance(Ci.nsIServerSocket);
                var range = module.getPref("portRange");
                var port = module.getPref("port");
                var loopbackonly = module.getPref("localOnly");
                var listener = {
                    onSocketAccepted: function(socket, transport) {
                        module.log("Reconnection request received");
                        server.reconnect();
                    },
                    onStopListening: function(serverSocket, status) {
                    }
                };
                for (var i = 1; i <= range; i++) {
                    // find some free port below the starting port
                    try {
                        server.init(port - i, loopbackonly, -1);
                        server.asyncListen(listener);
                        this.server = server;
                        return;
                    }
                    catch(e) {}
                }
                // it seems, no port is available
                module.error("No unused port available in given range: " + (port - range) + "-" + (port - 1));
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            stop: function() {
                dbg(">> XRefreshListener.stop", arguments);
                if (!this.server) return;
                this.server.close();
                this.server = null;
            }
        };
        
        ////////////////////////////////////////////////////////////////////////
        // Firebug.XRefresh extension module, here we go!
        //
        module = Firebug.XRefresh = extend(Firebug.ActivableModule, {
            events: [],
            /////////////////////////////////////////////////////////////////////////////////////////
            checkFirebugVersion: function() {
                var version = Firebug.getVersion();
                if (!version) return false;
                var a = version.split('.');
                if (a.length<2) return false;
                // we want Firebug version 1.4+ (including alphas/betas and other weird stuff)
                return parseInt(a[0], 10)>=1 && parseInt(a[1], 10)>=4;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            startupCheck: function() {
                if (!this.checkFirebugVersion()) {
                    this.log("XRefresh Firefox extension works only with Firebug 1.4. Please upgrade Firebug to latest version.", "warn");
                }
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            initialize: function() {
                dbg(">> XRefresh.initialize", arguments);
                this.panelName = 'XRefresh';
                this.description = "Browser refresh automation for web developers";
                Firebug.ActivableModule.initialize.apply(this, arguments);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            shutdown: function() {
                dbg(">> XRefresh.shutdown", arguments);
                Firebug.ActivableModule.shutdown.apply(this, arguments);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            onPanelEnable: function(context, panelName) {
                if (panelName != this.panelName) return;
                dbg(">> XRefresh.onPanelEnable", arguments);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            onPanelDisable: function(context, panelName) {
                if (panelName != this.panelName) return;
                dbg(">> XRefresh.onPanelDisable", arguments);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            onSuspendFirebug: function(context) {
                dbg(">> XRefresh.onSuspendFirebug", arguments);
                if (this.scheduledDisconnection) clearTimeout(this.scheduledDisconnection);
                this.scheduledDisconnection = setTimeout(function() {
                    server.disconnect();
                }, 5000);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            onResumeFirebug: function(context) {
                dbg(">> XRefresh.onResumeFirebug", arguments);
                if (this.scheduledDisconnection) clearTimeout(this.scheduledDisconnection);
                delete this.scheduledDisconnection;
                if (this.alreadyActivated) return;
                this.alreadyActivated = true;
                var that = this;
                setTimeout(function() {
                    that.startupCheck();
                }, 1000);
                setTimeout(function() {
                    server.connect();
                }, 1000);
                setTimeout(function() {
                    listener.start();
                }, 2000);
                this.checkTimeout = setTimeout(function() {
                    that.connectionCheck();
                }, 5000);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            disconnect: function(context) {
                dbg(">> XRefresh.disconnect", arguments);
                delete this.scheduledDisconnection;
                if (!this.alreadyActivated) return;
                this.alreadyActivated = false;
                // just after onPanelDeactivate, no remaining activecontext
                server.disconnect();
                listener.stop();
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            connectionCheck: function(context) {
                dbg(">> XRefresh.connectionCheck", arguments);
                delete this.checkTimeout;
                if (server.ready) return;
                this.log("Unable to connect to XRefresh Server", "warn");
                this.log("Please check if you have running XRefresh Server.", "bulb");
                this.log("    On Windows, it is program running in system tray. Look for Programs -> XRefresh -> XRefresh.exe", "bulb");
                this.log("    On Mac, it is running command-line program xrefresh-server. It should be available on system path after 'sudo gem install xrefresh-server'", "bulb");
                this.log("You may also want to check your firewall settings. XRefresh Firefox extension expects Server to talk from " + this.getPref('host') + " on port " + this.getPref('port'), "bulb");
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            shortConnectionCheck: function(context) {
                dbg(">> XRefresh.shortConnectionCheck", arguments);
                delete this.shortCheckTimeout;
                if (server.ready) return;
                this.log("Unable to connect to XRefresh Server. Please check if you have running XRefresh Server and tweak your firewall settings if needed.", "warn");
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            showPanel: function(browser, panel) {
                dbg(">> XRefresh.showPanel", arguments);
                Firebug.ActivableModule.showPanel.apply(this, arguments);
                var isXRefresh = panel && panel.name == this.panelName;
                if (isXRefresh) {
                    this.updatePanel(panel.context);
                }
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            visitWebsite: function() {
                dbg(">> XRefresh.visitWebsite", arguments);
                openNewTab(xrefreshHomepage);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            getPref: function(name) {
                var prefName = this.getPrefDomain() + "." + name;
                var type = xrefreshPrefs.getPrefType(prefName);
                if (type == nsIPrefBranch.PREF_STRING)
                return xrefreshPrefs.getCharPref(prefName);
                else if (type == nsIPrefBranch.PREF_INT)
                return xrefreshPrefs.getIntPref(prefName);
                else if (type == nsIPrefBranch.PREF_BOOL)
                return xrefreshPrefs.getBoolPref(prefName);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            setPref: function(name, value) {
                var prefName = this.getPrefDomain() + "." + name;
                var type = xrefreshPrefs.getPrefType(prefName);
                if (type == nsIPrefBranch.PREF_STRING)
                xrefreshPrefs.setCharPref(prefName, value);
                else if (type == nsIPrefBranch.PREF_INT)
                xrefreshPrefs.setIntPref(prefName, value);
                else if (type == nsIPrefBranch.PREF_BOOL)
                xrefreshPrefs.setBoolPref(prefName, value);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            initContext: function(context) {
                dbg(">> XRefresh.initContext: " + context.window.document.URL);
                Firebug.ActivableModule.initContext.apply(this, arguments);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            reattachContext: function(context) {
                dbg(">> XRefresh.reattachContext: " + context.window.document.URL);
                Firebug.ActivableModule.reattachContext.apply(this, arguments);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            destroyContext: function(context, persistedState) {
                dbg(">> XRefresh.destroyContext: " + context.window.document.URL);
                Firebug.ActivableModule.destroyContext.apply(this, arguments);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            showContext: function(browser, context) {
                if (!context) return; // BUG in FB1.4?
                dbg(">> XRefresh.showContext: " + context.window.document.URL);
                Firebug.ActivableModule.showContext.apply(this, arguments);
                this.updatePanel(context);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            loadedContext: function(context) {
                dbg(">> XRefresh.loadedContext: " + context.window.document.URL);
                Firebug.ActivableModule.loadedContext.apply(this, arguments);
                if (!this.isEnabled(context)) return;
                this.sendSetPage(context.browser.contentTitle, context.window.document.URL);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            buttonRefresh: function(context) {
                dbg(">> XRefresh.buttonRefresh: " + context.window.document.URL);
                context.getPanel(this.panelName).refresh(context);
                this.log("Manual refresh performed by user", "rreq");
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            buttonStatus: function(context) {
                dbg(">> XRefresh.buttonStatus: " + context.window.document.URL);
                if (this.checkTimeout) clearTimeout(this.checkTimeout);
                delete this.checkTimeout;
                if (this.shortCheckTimeout) clearTimeout(this.shortCheckTimeout);
                delete this.shortCheckTimeout;
                if (server.ready) {
                    this.log("Disconnection requested by user", "disconnect_btn");
                    server.disconnect();
                } else {
                    this.log("Connection requested by user", "connect_btn");
                    server.connect();
                    this.shortCheckTimeout = setTimeout(function() {
                        module.shortConnectionCheck();
                    }, 3000);
                }
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            getMessageCSSFiles: function(message) {
                var files = [];
                var re = /\.css$/;
                for (var i = 0; i < message.files.length; i++) {
                    var file = message.files[i];
                    if (file.action == 'changed') {
                        if (file.path1.match(re)) {
                            files.push(message.root + '\\' + file.path1);
                            // TODO: this should be platform specific
                        }
                    }
                }
                return files;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            processMessage: function(message) {
                dbg(">> XRefresh.processMessage:"+ message.command);
                if (!this.isEnabled(this.currentContext)) {
                    dbg("Skipped message because the panel is not enabled");
                    return;
                }
                if (message.command == "DoRefresh") {
                    if (this.getPref("softRefresh")) {
                        var cssFiles = this.getMessageCSSFiles(message);
                        if (cssFiles.length == message.files.length) { // message contains only CSS files?

                            TabWatcher.iterateContexts(function(context) {
                                module.showEvent(context, message, 'fastcss');
                                var panel = context.getPanel(module.panelName);
                                panel.updateCSS(context, cssFiles); // perform soft refresh
                            });
                            
                            return;
                        }
                    }
                    
                    TabWatcher.iterateContexts(function(context) {
                        module.showEvent(context, message, 'refresh');
                        var panel = context.getPanel(module.panelName);
                        panel.refresh(context);
                    });
                    
                    return;
                }
                if (message.command == "AboutMe") {
                    server.ready = true;
                    server.name = message.agent;
                    server.version = message.version;
                    this.log("Connected to " + server.name + " " + server.version, "connect");
                    this.updatePanels();
                    TabWatcher.iterateContexts(function(context) {
                        server.sendSetPage(context.browser.contentTitle, context.window.document.URL);
                    });
                    return;
                }
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            updatePanels: function() {
                var that = this;
                TabWatcher.iterateContexts(function(context) {
                    that.updatePanel(context);
                });
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            updatePanel: function(context) {
                // safety net
                var panel = context.getPanel(this.panelName);
                if (!panel) return;
                var browser = panel.context.browser;
                if (!browser) return;
                var buttonStatus = browser.chrome.$("fbXRefreshButtonStatus");
                if (!buttonStatus) return;
                buttonStatus.className = "toolbar-text-button toolbar-connection-status";
                if (server.ready) {
                    buttonStatus.label = "Connected to " + server.name + " " + server.version;
                    setClass(buttonStatus, "toolbar-text-button toolbar-status-connected");
                } else {
                    buttonStatus.label = "Disconnected";
                    setClass(buttonStatus, "toolbar-text-button toolbar-status-disconnected");
                }
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            getCurrentTime: function() {
                var d = new Date();
                var h = d.getHours() + "";
                var m = d.getMinutes() + "";
                var s = d.getSeconds() + "";
                while (h.length < 2) h = "0" + h;
                while (m.length < 2) m = "0" + m;
                while (s.length < 2) s = "0" + s;
                return h + ":" + m + ":" + s;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            showEvent: function(context, message, icon) {
                message.time = this.getCurrentTime();
                var event = new XRefreshLogRecord(0, message, icon);
                return this.publishEvent(context, event);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            showLog: function(context, text, icon) {
                var event = new XRefreshLogRecord(1, { text: text, time: this.getCurrentTime() }, icon);
                return this.publishEvent(context, event);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            log: function(text, icon) {
                if (!icon) icon = "info";
                TabWatcher.iterateContexts(function(context) {
                    module.showLog(context, text, icon);
                });
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            error: function(text, icon) {
                if (!icon) icon = "error";
                TabWatcher.iterateContexts(function(context) {
                    module.showLog(context, text, icon);
                });
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            publishEvent: function(context, event) {
                dbg(">> XRefresh.publishEvent", arguments);
                var panel = context.getPanel(this.panelName);
                if (!panel) {
                    dbg("  !! unable to lookup panel:"+this.panelName);
                    return;
                }
                this.events.push(event);
                panel.publish(event);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            republishAllEvents: function(panel) {
                dbg(">> XRefresh.republishAllEvents", arguments);
                for (var i=0; i < this.events.length; i++) {
                    panel.publish(this.events[i]);
                }
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            storePageOffset: function(context) {
                dbg("Storing offsets for " + context.window.document.URL);
                // recorder.offsets = [context.window.pageXOffset, context.window.pageYOffset];
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            restorePageOffset: function(context) {
                dbg("Restoring offsets for " + context.window.document.URL);
                // context.window.scrollTo(data[0], data[1]);
            }
        });

        ////////////////////////////////////////////////////////////////////////
        //
        //
        top.XRefreshLogRecord = function(type, message, icon) {
            this.type = type;
            this.message = message;
            this.opened = false;
            this.icon = icon;
        };

        Firebug.XRefresh.Record = domplate(Firebug.Rep, {
            tagRefresh:
                DIV({class: "blinkHead closed $object|getIcon", _repObject: "$object"},
                    A({class: "blinkTitle", onclick: "$onToggleBody"},
                        IMG({class: "blinkIcon", src: "blank.gif"}),
                        SPAN({class: "blinkDate"}, "$object|getDate"),
                        SPAN({class: "blinkURI" }, "$object|getCaption"),
                        SPAN({class: "blinkInfo"}, "$object|getInfo")
                    ),
                    DIV({class: "details"})
                ),

            tagLog:
                DIV({class: "blinkHead $object|getIcon", _repObject: "$object"},
                    A({class: "blinkTitle"},
                        IMG({class: "blinkIcon", src:"blank.gif"}),
                        SPAN({class: "blinkDate"}, "$object|getDate"),
                        SPAN({class: "blinkURI"}, "$object|getCaption")
                    )
                ),

            /////////////////////////////////////////////////////////////////////////////////////////
            getCaption: function(event) {
                if (event.type == 0) return 'Project \'' + event.message.name + '\': ';
                if (event.type == 1) return event.message.text;
                return "???";
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            getIcon: function(event) {
                return event.icon;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            getDate: function(event) {
                return ' [' + event.message.time + ']';
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            filesSentence: function(i, s) {
                if (i == 0) return null;
                if (i == 1) return 'one item ' + s;
                return i + ' items ' + s;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            glue: function(a) {
                if (!a.length) return "";
                var last = a.length - 1;
                var s = a[0];
                for (var i = 1; i < a.length; i++)
                {
                    if (i == last) s += " and ";
                    else s += ", ";
                    s += a[i];
                }
                return s;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            getInfo: function(event) {
                var m = event.message;
                var changed = 0;
                var created = 0;
                var deleted = 0;
                var renamed = 0;
                for (var i = 0; i < m.files.length; i++)
                {
                    var file = m.files[i];
                    if (file.action == "changed") changed++;
                    if (file.action == "created") created++;
                    if (file.action == "deleted") deleted++;
                    if (file.action == "renamed") renamed++;
                }

                var s1 = this.filesSentence(created, "created");
                var s2 = this.filesSentence(deleted, "deleted");
                var s3 = this.filesSentence(changed, "changed");
                var s4 = this.filesSentence(renamed, "renamed");
                var a = [];
                if (s1) a.push(s1);
                if (s2) a.push(s2);
                if (s3) a.push(s3);
                if (s4) a.push(s4);
                return this.glue(a);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            onToggleBody: function(e) {
                if (isLeftClick(e)) this.toggle(e.currentTarget);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            toggle: function(target) {
                var logRow = getAncestorByClass(target, "logRow-blink");
                var row = getChildByClass(logRow, "blinkHead")
                var event = row.repObject;
                if (event.type != 0) return;

                var details = getChildByClass(row, "details");

                toggleClass(row, "opened");
                toggleClass(row, "closed");

                event.opened = false;
                if (hasClass(row, "opened"))
                {
                    event.opened = true;
                    this.showEventDetails(event, details);
                }
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            showEventDetails: function(event, details) {
                var s = '';
                var m = event.message;
                s += '<table class="ftable" cellpadding="0" cellspacing="0">';
                s += '<tr><td class="froot" colspan="2">' + m.root + '</td></tr>';

                for (var i = 0; i < m.files.length; i++) {
                    var file = m.files[i];
                    fa = file.path1.split('\\');
                    if (fa.length > 0) {
                        fa2 = fa.pop();
                        fa1 = fa.join('\\');
                        if (fa1) fa1 += '\\';

                        if (!file.path2) {
                            s += '<tr><td class="faction ' + file.action + '"></td><td class="ffile"><span class="ffa1">' + fa1 + '</span><span class="ffa2">' + fa2 + '</span></td></tr>';
                        } else {
                            fb = file.path2.split('\\');
                            fb2 = fb.pop();
                            fb1 = fb.join('\\');
                            if (fb1) fb1 += '\\';
                            s += '<tr><td class="faction ' + file.action + '"></td><td class="ffile"><span class="ffa1">' + fa1 + '</span><span class="ffa2">' + fa2 + '</span> -&gt; <span class="ffb1">' + fb1 + '</span><span class="ffb2">' + fb2 + '</span></td></tr>';
                        }
                    }
                }
                s += '</table>';
                details.innerHTML = s;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            supportsObject: function(object) {
                return object instanceof XRefreshLogRecord;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            getRealObject: function(event, context) {
                return event.message;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            getContextMenuItems: function(event) {
                return null;
            }
        });

        function XRefreshPanel() {}
        XRefreshPanel.prototype = extend(Firebug.ActivablePanel, {
            name: "XRefresh",
            title: "XRefresh",
            searchable: false,
            editable: false,
            wasScrolledToBottom: true,
            /////////////////////////////////////////////////////////////////////////////////////////
            enablePanel: function(module) {
                dbg(">> XRefreshPanel.enablePanel; " + this.context.getName());
                Firebug.ActivablePanel.enablePanel.apply(this, arguments);
                this.clear();
                Firebug.XRefresh.republishAllEvents(this);
                if (this.wasScrolledToBottom)
                    scrollToBottom(this.panelNode);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            disablePanel: function(module) {
                dbg(">> XRefreshPanel.disablePanel; " + this.context.getName());
                Firebug.ActivablePanel.disablePanel.apply(this, arguments);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            initialize: function() {
                dbg(">> XRefreshPanel.initialize", arguments);
                Firebug.ActivablePanel.initialize.apply(this, arguments);
                this.applyCSS();
                Firebug.XRefresh.republishAllEvents(this);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            applyCSS: function() {
                this.applyPanelCSS("chrome://xrefresh/skin/panel.css");
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            safeGetURI: function(browser) {
                try {
                    return this.context.browser.currentURI;
                } catch(e) {}
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            refresh: function(context) {
                dbg(">> XRefreshPanel.refresh", arguments);
                var uri = this.safeGetURI();
                Firebug.XRefresh.storePageOffset(context);
                var browser = context.browser;
                var url = context.window.document.location;
                browser.loadURIWithFlags(url, browser.webNavigation.LOAD_FLAGS_FROM_EXTERNAL);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            updateStyleSheet: function(document, element, path) {
                var file = localFile.createInstance(Ci.nsILocalFile);
                file.initWithPath(path);
                var observer = {
                    onStreamComplete: function(aLoader, aContext, aStatus, aLength, aResult) {
                        var styleElement = document.createElement("style");
                        styleElement.setAttribute("type", "text/css");
                        styleElement.appendChild(document.createTextNode(aResult));
                        var attrs = ["media", "title", "disabled"];
                        for (var i = 0; i < attrs.length; i++) {
                            var attr = attrs[i];
                            if (element.hasAttribute(attr)) styleElement.setAttribute(attr, element.getAttribute(attr));
                        }
                        element.parentNode.replaceChild(styleElement, element);
                        styleElement.originalHref = element.originalHref ? element.originalHref: element.href;
                    }
                };
                var inputStream = fileInputStream.createInstance(Components.interfaces.nsIFileInputStream);
                var scriptableStream = inputStream.createInstance(Components.interfaces.nsIScriptableInputStream);

                inputStream.init(file, -1, 0, 0);
                scriptableStream.init(inputStream);
                var content = scriptableStream.read(scriptableStream.available());
                scriptableStream.close();
                inputStream.close();

                observer.onStreamComplete(null, null, null, null, content);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            collectDocuments: function(frame) {
                var documents = [];
                if (!frame) return documents;
                if (frame.document) documents.push(frame.document);
                var frames = frame.frames;
                for (var i = 0; i < frames.length; i++) documents = documents.concat(this.collectDocuments(frames[i]));
                return documents;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            doesCSSNameMatch: function(cssLink, cssFile) {
                var firstQ = cssLink.indexOf('?');
                if (firstQ != -1) cssLink = cssLink.substring(0, firstQ);
                var lastLinkSlash = cssLink.lastIndexOf('/');
                if (lastLinkSlash != -1) cssLink = cssLink.substring(lastLinkSlash + 1);
                var lastFileSlash = cssFile.lastIndexOf('/');
                if (lastFileSlash != -1) cssFile = cssFile.substring(lastFileSlash + 1);
                var res = (cssFile.toLowerCase() == cssLink.toLowerCase());
                dbg('Match ' + cssLink + ' vs. ' + cssFile + ' result:' + (res ? 'true': 'false'));
                return res;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            replaceMatchingStyleSheetsInDocument: function(document, cssFile) {
                dbg('Replacing CSS in document', document);
                var styleSheetList = document.styleSheets;
                for (var i = 0; i < styleSheetList.length; i++) {
                    var styleSheetNode = styleSheetList[i].ownerNode;
                    // this may be <style> or <link> node
                    if (!styleSheetNode) continue;
                    var href = styleSheetNode.href || styleSheetNode.originalHref;
                    if (!href) continue;
                    if (this.doesCSSNameMatch(href, cssFile)) this.updateStyleSheet(document, styleSheetNode, cssFile);
                }
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            replaceMatchingStyleSheets: function(context, cssFile) {
                var documents = this.collectDocuments(context.window);
                for (var i = 0; i < documents.length; i++) this.replaceMatchingStyleSheetsInDocument(documents[i], cssFile);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            updateCSS: function(context, cssFiles) {
                dbg('Replacing css files', cssFiles);
                for (var i = 0; i < cssFiles.length; i++)
                {
                    var cssFile = cssFiles[i].replace('\\', '/'); // convert windows backslashes to forward slashes
                    this.replaceMatchingStyleSheets(context, cssFile);
                }
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            publish: function(event) {
                dbg(">> XRefreshPanel.publish", arguments);
                this.append(event, "blink", null, null);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            clear: function() {
                dbg(">> XRefreshPanel.clear", arguments);
                if (!this.panelNode) return;
                clearNode(this.panelNode);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            show: function(state) {
                dbg(">> XRefreshPanel.show", arguments);
                var enabled = Firebug.XRefresh.isAlwaysEnabled();
                if (enabled) {
                     Firebug.XRefresh.disabledPanelPage.hide(this);
                     this.showToolbarButtons("fbXRefreshControls", true);
                     if (this.wasScrolledToBottom)
                     scrollToBottom(this.panelNode);
                } else {
                    this.hide();
                    Firebug.XRefresh.disabledPanelPage.show(this);
                }
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            hide: function() {
                dbg(">> XRefreshPanel.hide", arguments);
                this.showToolbarButtons("fbXRefreshControls", false);
                this.wasScrolledToBottom = isScrolledToBottom(this.panelNode);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            updateOption: function(name, value) {
                dbg(">> XRefreshPanel.updateOption", arguments);
                
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            getOptionsMenuItems: function() {
                dbg(">> XRefreshPanel.getOptionsMenuItems", arguments);
                return [
                    optionMenu("Use Soft Refresh (if possible)", "softRefresh"),
                    '-',
                    {
                        label: "Visit XRefresh Website...",
                        nol10n: true,
                        command: function() {
                            Firebug.XRefresh.visitWebsite();
                        }
                    }
                ];
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            getTopContainer: function() {
                return this.panelNode;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            createRow: function(rowName, className) {
                var elt = this.document.createElement("div");
                elt.className = rowName + (className ? " " + rowName + "-" + className: "");
                return elt;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            append: function(objects, className, rep) {
                var container = this.getTopContainer();
                var scrolledToBottom = isScrolledToBottom(this.panelNode);
                var row = this.createRow("logRow", className);
                this.appendObject.apply(this, [objects, row, rep]);
                container.appendChild(row);
                if (scrolledToBottom) scrollToBottom(this.panelNode);
                return row;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            appendObject: function(object, row, rep) {
                var rep = rep ? rep: Firebug.getRep(object);
                var res = "";
                switch (object.type) {
                    case 0: res = rep.tagRefresh.append({ object: object }, row); break;
                    case 1: res = rep.tagLog.append({ object: object }, row); break;
                }
                if (object.opened) {
                    rep.toggle(row.childNodes[0].childNodes[0]);
                }
                return res;
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            applyPanelCSS: function(url) {
                var links = FBL.getElementsBySelector(this.document, "link");
                for (var i=0; i < links.length; i++) {
                    var link = links[i];
                    if (link.getAttribute('href')==url) return; // already applied
                }
                var styleElement = this.document.createElement("link");
                styleElement.setAttribute("type", "text/css");
                styleElement.setAttribute("href", url);
                styleElement.setAttribute("rel", "stylesheet");

                var head = this.getHeadElement(this.document);
                if (head) head.appendChild(styleElement);
            },
            /////////////////////////////////////////////////////////////////////////////////////////
            getHeadElement: function(doc) {
                var heads = doc.getElementsByTagName("head");
                if (heads.length == 0) return doc.documentElement;
                return heads[0];
            }
        });

        Firebug.registerActivableModule(Firebug.XRefresh);
        Firebug.registerRep(Firebug.XRefresh.Record);
        Firebug.registerPanel(XRefreshPanel);
    }
}); // close custom scope