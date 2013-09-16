/*
 * Copyright (c) 2013 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */


/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4 */
/*global define, $, Mustache, brackets */

/**
 * Manages linters and other code inspections on a per-language basis. Provides a UI and status indicator for
 * the resulting errors/warnings.
 *
 * Currently, inspection providers are only invoked on the current file and only when it is opened, switched to,
 * or saved. But in the future, inspectors may be invoked as part of a global scan, at intervals while typing, etc.
 * Currently, results are only displayed in a bottom panel list and in a status bar icon. But in the future,
 * results may also be displayed inline in the editor (as gutter markers, squiggly underlines, etc.).
 * In the future, support may also be added for error/warning providers that cannot process a single file at a time
 * (e.g. a full-project compiler).
 */
define(function (require, exports, module) {
    "use strict";
    
    // Load dependent modules
    var Commands                = require("command/Commands"),
        PanelManager            = require("view/PanelManager"),
        CommandManager          = require("command/CommandManager"),
        DocumentManager         = require("document/DocumentManager"),
        EditorManager           = require("editor/EditorManager"),
        LanguageManager         = require("language/LanguageManager"),
        PreferencesManager      = require("preferences/PreferencesManager"),
        PerfUtils               = require("utils/PerfUtils"),
        Strings                 = require("strings"),
        StringUtils             = require("utils/StringUtils"),
        AppInit                 = require("utils/AppInit"),
        Resizer                 = require("utils/Resizer"),
        StatusBar               = require("widgets/StatusBar"),
        Menus                   = require("command/Menus"),
        PanelTemplate           = require("text!htmlContent/problems-panel.html"),
        ResultsTemplate         = require("text!htmlContent/problems-panel-table.html");
    
    var INDICATOR_ID = "status-inspection",
        defaultPrefs = {
            enabled: brackets.config["linting.enabled_by_default"],
            collapsed: false
        };
    
    /** Values for problem's 'type' property */
    var Type = {
        /** Unambiguous error, such as a syntax error */
        ERROR: "problem_type_error",
        /** Maintainability issue, probable error / bad smell, etc. */
        WARNING: "problem_type_warning",
        /** Inspector unable to continue, code too complex for static analysis, etc. Not counted in error/warning tally. */
        META: "problem_type_meta"
    };
    
    
    /**
     * @private
     * @type {PreferenceStorage}
     */
    var _prefs = null;
    
    /**
     * When disabled, the errors panel is closed and the status bar icon is grayed out.
     * Takes precedence over _collapsed.
     * @private
     * @type {boolean}
     */
    var _enabled = true;
    
    /**
     * When collapsed, the errors panel is closed but the status bar icon is kept up to date.
     * @private
     * @type {boolean}
     */
    var _collapsed = false;
    
    /**
     * @private
     * @type {$.Element}
     */
    var $problemsPanel;
    
    /**
     * @private
     * @type {boolean}
     */
    var _gotoEnabled = false;
    
    /**
     * @private
     * @type {Object.<string, {name:string, scanFile:function(string, string):Object}>}
     */
    var _providers = {};
    
    /**
     * @private
     * @type {?Array.<Object>}
     */
    var _lastResult;
    
    /**
     * @private
     * @type {?Array.<Commands>}
     */
    var _allInspectorCommands = [];

    /**
     * Enable or disable the "Go to First Error" command
     * @param {boolean} gotoEnabled Whether it is enabled.
     */
    function setGotoEnabled(gotoEnabled) {
        CommandManager.get(Commands.NAVIGATE_GOTO_FIRST_PROBLEM).setEnabled(gotoEnabled);
        _gotoEnabled = gotoEnabled;
    }

    /**
     * Construct a preference key for the code inspector/provider.
     * limitation: this function doesn't account for provider with the same name, which could
     * result in preferences from one provider overwritten with the ones from another.
     *
     * @param {name:string, scanFile:function(string, string):Object} provider
     */
    function getProviderPrefKey(provider) {
        return "inspector." + provider.name + ".enabled";
    }
    
    /**
     * Check if a given provider/code inspector is enabled.
     * Return true if enabled, false otherwise.
     *
     * @param {name:string, scanFile:function(string, string):Object} provider
     */
    function isProviderEnabled(provider) {
        return _prefs.getValue(getProviderPrefKey(provider));
    }

    /**
     * Store the state (enabled/disabled) for a given provider/code inspector.
     * Return true if enabled, false otherwise.
     *
     * @param {name:string, scanFile:function(string, string):Object} provider
     * @param boolean enabled
     */
    function setProviderEnabled(provider, enabled) {
        _prefs.setValue(getProviderPrefKey(provider), enabled);
    }

    /**
     * Create a menu entry for the given provider/code inspector.
     * The command that is created for this menu entry will be stored for later use. The event handler for this new menu item will handle the enable/disable toggle for the provider/code inspector.
     *
     * @param {name:string, scanFile:function(string, string):Object} provider
     */
    function addMenuEntryForProvider(provider) {
        var menuString    = StringUtils.format(Strings.CMD_VIEW_ENABLE_INSPECTOR, provider.name),
            commandString = "command.inspector." + provider.name;

        var inspectorCommand = CommandManager.register("  Enable " + provider.name, commandString, function () {
            this.setChecked(!this.getChecked());

            _prefs.setValue(getProviderPrefKey(provider), this.getChecked());

            // update results
            run();
        });

        _allInspectorCommands.push(inspectorCommand);

        // add a new MenuItem for each inspector
        var viewMenu = Menus.getMenu(Menus.AppMenuBar.VIEW_MENU);
        viewMenu.addMenuItem(inspectorCommand, null, Menus.AFTER, Commands.VIEW_TOGGLE_INSPECTION);

        var providerEnabled = isProviderEnabled(provider);
        inspectorCommand.setChecked(providerEnabled);
        inspectorCommand.setEnabled(_prefs.getValue("enabled"));
    }

    /**
     * Enable/disable all menu entries for provider/code inspector.
     *
     * param boolean enabled
     */
    function toggleEnableAllInspectorMenuItems(enabled) {
        _allInspectorCommands.forEach(function(command) {
            command.setEnabled(enabled);
        });
    }
    
    /**
     * The provider is passed the text of the file and its fullPath. Providers should not assume
     * that the file is open (i.e. DocumentManager.getOpenDocumentForPath() may return null) or
     * that the file on disk matches the text given (file may have unsaved changes).
     *
     * @param {string} languageId
     * @param {{name:string, scanFile:function(string, string):?{!errors:Array, aborted:boolean}} provider
     *
     * Each error is: { pos:{line,ch}, endPos:?{line,ch}, message:string, type:?Type }
     * If type is unspecified, Type.WARNING is assumed.
     */
    function register(languageId, provider) {
        if (!_providers[languageId]) {
            _providers[languageId] = [];
        }

        _providers[languageId].push(provider);

        addMenuEntryForProvider(provider);
    }

    /**
     * Run inspector applicable to current document. Updates status bar indicator and refreshes error list in
     * bottom panel.
     */
    function run() {
        if (!_enabled) {
            Resizer.hide($problemsPanel);
            StatusBar.updateIndicator(INDICATOR_ID, true, "inspection-disabled", Strings.LINT_DISABLED);
            setGotoEnabled(false);
            return;
        }
        
        var currentDoc = DocumentManager.getCurrentDocument();
        
        var numProblems = 0,
            aborted = false,
            resultList = [];

        var perfTimerDOM,
            perfTimerInspector;
        
        var language = currentDoc ? LanguageManager.getLanguageForPath(currentDoc.file.fullPath) : "";
        var languageId = language && language.getId();
        var providers = (language && _providers[languageId]) || [];
        
        if (providers.length > 0) {
            perfTimerInspector = PerfUtils.markStart("CodeInspection '" + languageId + "':\t" + currentDoc.file.fullPath);
            
            providers.forEach(function (provider) {
                if (isProviderEnabled(provider)) {
                    var result = provider.scanFile(currentDoc.getText(), currentDoc.file.fullPath);
                    _lastResult = result;

                    PerfUtils.addMeasurement(perfTimerInspector);
                    perfTimerDOM = PerfUtils.markStart("ProblemsPanel render:\t" + currentDoc.file.fullPath);

                    if (result && result.errors.length) {
                        // Augment error objects with additional fields needed by Mustache template
                        var _numProblemsReportedByProvider = 0;
                        result.errors.forEach(function (error) {
                            error.friendlyLine = error.pos.line + 1;

                            error.codeSnippet = currentDoc.getLine(error.pos.line);
                            error.codeSnippet = error.codeSnippet.substr(0, Math.min(175, error.codeSnippet.length));  // limit snippet width

                            if (error.type !== Type.META) {
                                numProblems++;
                                _numProblemsReportedByProvider++;
                            }
                        });

                        resultList.push({
                            providerName: provider.name,
                            results:      result.errors,
                            numProblems:  _numProblemsReportedByProvider
                        });
                    }

                    // if the code inspector was unable to process the whole file, we keep track to show a different status
                    if (result && result.aborted) {
                        aborted = true;
                    }

                    PerfUtils.addMeasurement(perfTimerDOM);
                }
            });

            // Update results table
            var html = Mustache.render(ResultsTemplate, {reportList: resultList});
            var $selectedRow;

            $problemsPanel.find(".table-container")
                .empty()
                .append(html)
                .scrollTop(0)  // otherwise scroll pos from previous contents is remembered
                .off(".table-container")  // Remove the old events
                .on("click", function (e) {
                    var $row = $(e.target).closest("tr");

                    console.log("Target: " + e.target.toString());
                    console.log("Header clicked" + $row.toString());
                    if ($row.length) {
                        if ($selectedRow) {
                            $selectedRow.removeClass("selected");
                        }

                        $row.addClass("selected");
                        $selectedRow = $row;

                        // This is a inspector title row, expand/collapse on click
                        if ($row.hasClass("inspector-section")) {
                            // Clicking the inspector title section header collapses/expands result rows
                            $row.nextUntil(".inspector-section").toggle();

                            var $triangle = $(".disclosure-triangle", $row);
                            $triangle.toggleClass("expanded").toggleClass("collapsed");
                        // This is a problem marker row, show the result on click
                        } else {
                            // Grab the required position data
                            var $lineTd   = $selectedRow.find("td.line-number"),
                                line      = parseInt($lineTd.text(), 10) - 1,  // convert friendlyLine back to pos.line
                                character = $lineTd.data("character"),
                                editor    = EditorManager.getCurrentFullEditor();

                            editor.setCursorPos(line, character, true);
                            EditorManager.focusEditor();
                        }
                    }
                });
            
            $problemsPanel.find(".title").text(StringUtils.format(Strings.ERRORS_PANEL_TITLE, Strings.PROBLEMS_PANEL_TITLE));
            if (!_collapsed) {
                Resizer.show($problemsPanel);
            }

            if (numProblems === 1 && !aborted) {
                StatusBar.updateIndicator(INDICATOR_ID, true, "inspection-errors", StringUtils.format(Strings.SINGLE_ERROR, Strings.PROBLEMS_PANEL_TITLE));
            } else {
                // If inspector was unable to process the whole file, number of errors is indeterminate; indicate with a "+"
                if (aborted) {
                    numProblems += "+";
                }
                StatusBar.updateIndicator(INDICATOR_ID, true, "inspection-errors",
                    StringUtils.format(Strings.MULTIPLE_ERRORS, Strings.PROBLEMS_PANEL_TITLE, numProblems));
            }
            setGotoEnabled(true);

            if (!numProblems) {
                Resizer.hide($problemsPanel);
                StatusBar.updateIndicator(INDICATOR_ID, true, "inspection-valid", StringUtils.format(Strings.NO_ERRORS, Strings.PROBLEMS_PANEL_TITLE));
                setGotoEnabled(false);
            }
        } else {
            // No provider for current file
            _lastResult = null;
            Resizer.hide($problemsPanel);
            if (language) {
                StatusBar.updateIndicator(INDICATOR_ID, true, "inspection-disabled", StringUtils.format(Strings.NO_LINT_AVAILABLE, language.getName()));
            } else {
                StatusBar.updateIndicator(INDICATOR_ID, true, "inspection-disabled", Strings.NOTHING_TO_LINT);
            }
            setGotoEnabled(false);
        }
    }
    
    /**
     * Update DocumentManager listeners.
     */
    function updateListeners() {
        if (_enabled) {
            // register our event listeners
            $(DocumentManager)
                .on("currentDocumentChange.codeInspection", function () {
                    run();
                })
                .on("documentSaved.codeInspection documentRefreshed.codeInspection", function (event, document) {
                    if (document === DocumentManager.getCurrentDocument()) {
                        run();
                    }
                });
        } else {
            $(DocumentManager).off(".codeInspection");
        }
    }
    
    /**
     * Enable or disable all inspection.
     * @param {?boolean} enabled Enabled state. If omitted, the state is toggled.
     */
    function toggleEnabled(enabled) {
        if (enabled === undefined) {
            enabled = !_enabled;
        }
        _enabled = enabled;
        
        CommandManager.get(Commands.VIEW_TOGGLE_INSPECTION).setChecked(_enabled);
        updateListeners();
        _prefs.setValue("enabled", _enabled);
    
        toggleEnableAllInspectorMenuItems(_enabled);

        // run immediately
        run();
    }
    
    
    /** 
     * Toggle the collapsed state for the panel. This explicitly collapses the panel (as opposed to
     * the auto collapse due to files with no errors & filetypes with no provider). When explicitly
     * collapsed, the panel will not reopen automatically on switch files or save.
     * 
     * @param {?boolean} collapsed Collapsed state. If omitted, the state is toggled.
     */
    function toggleCollapsed(collapsed) {
        if (collapsed === undefined) {
            collapsed = !_collapsed;
        }
        
        _collapsed = collapsed;
        _prefs.setValue("collapsed", _collapsed);
        
        if (_collapsed) {
            Resizer.hide($problemsPanel);
        } else {
            if (_lastResult && _lastResult.errors.length) {
                Resizer.show($problemsPanel);
            }
        }
    }
    
    /** Command to go to the first Error/Warning */
    function handleGotoFirstProblem() {
        run();
        if (_gotoEnabled) {
            $problemsPanel.find("tr:nth-child(2)").trigger("click");
        }
    }
    
    
    // Register command handlers
    CommandManager.register(Strings.CMD_VIEW_TOGGLE_INSPECTION, Commands.VIEW_TOGGLE_INSPECTION,        toggleEnabled);
    CommandManager.register(Strings.CMD_GOTO_FIRST_PROBLEM,     Commands.NAVIGATE_GOTO_FIRST_PROBLEM,   handleGotoFirstProblem);
    
    // Init PreferenceStorage
    _prefs = PreferencesManager.getPreferenceStorage(module, defaultPrefs);
    
    // Initialize items dependent on HTML DOM
    AppInit.htmlReady(function () {
        // Create bottom panel to list error details
        var panelHtml = Mustache.render(PanelTemplate, Strings);
        var resultsPanel = PanelManager.createBottomPanel("errors", $(panelHtml), 100);
        $problemsPanel = $("#problems-panel");
        
        $("#problems-panel .close").click(function () {
            toggleCollapsed(true);
        });
        
        // Status bar indicator - icon & tooltip updated by run()
        var statusIconHtml = Mustache.render("<div id=\"status-inspection\">&nbsp;</div>", Strings);
        $(statusIconHtml).insertBefore("#status-language");
        StatusBar.addIndicator(INDICATOR_ID, $("#status-inspection"));
        
        $("#status-inspection").click(function () {
            // Clicking indicator toggles error panel, if any errors in current file
            if (_lastResult && _lastResult.errors.length) {
                toggleCollapsed();
            }
        });
        
        
        // Set initial UI state
        toggleEnabled(_prefs.getValue("enabled"));
        toggleCollapsed(_prefs.getValue("collapsed"));
    });
    
    
    // Public API
    exports.register        = register;
    exports.Type            = Type;
    exports.toggleEnabled   = toggleEnabled;
});
