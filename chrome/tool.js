/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
'use strict';

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr } = Components;

Cu.import('resource://gre/modules/Services.jsm');
Cu.import('resource://gre/modules/XPCOMUtils.jsm');

XPCOMUtils.defineLazyModuleGetter(this, 'EventEmitter',
  'resource://gre/modules/devtools/event-emitter.js');

const require = Cu.import('resource://gre/modules/devtools/Loader.jsm', {}).devtools.require;
const promise = require('devtools/toolkit/deprecated-sync-thenables');
const SourceEditor = require('devtools/sourceeditor/editor');
const DebuggerEditor = require("devtools/sourceeditor/debugger.js");

XPCOMUtils.defineLazyGetter(this, 'toolStrings', () =>
  Services.strings.createBundle('chrome://debugger-addon/locale/strings.properties'));

let dom = React.DOM;
let activeThread;

// state management

let state = {};

function resetState() {
  // Never throw away breakpoints
  let bps = state.breakpoints;
  state = {
    paused: false,
    sources: [],
    selectedSourceData: {},
    breakpoints: bps || {}
  };
  return state;
}

function onPaused(event, packet) {
  state.paused = true;
  if(packet.why.type === 'breakpoint') {
    let sources = state.sources;
    let where = packet.frame.where;
    for(var i in sources) {
      if(sources[i].url === where.url) {
        selectSource(sources[i], { debug: where.line });
        break;
      }
    }
  }
  render(state);
}

function onResumed() {
  state.paused = false;
  state.selectedSourceData.debugLine = null;
  render(state);
}

function togglePaused() {
  if(state.paused) {
    activeThread.resume();
  }
  else {
    activeThread.interrupt();
  }
}

function addSource(notification, packet) {
  state.sources.push(packet.source);
  render(state);
}

function selectSource(source, opts) {
  state.selectedSourceData = { text: 'loading' };
  render(state);

  activeThread.source(source).source(res => {
    if(res.error){
      state.selectedSourceData = { text: 'error' }
    }
    else {
      state.selectedSourceData = { url: source.url,
                                   text: res.source,
                                   contentType: res.contentType };

      if(opts.debug) {
        state.selectedSourceData.debugLine = opts.debug;
      }
    }
    render(state);
  });
}

function toggleBreakpoint(line) {
  let sourceData = state.selectedSourceData;
  let url = sourceData.url;
  if(url) {
    let loc = { url: url, line: line };
    let found = false;

    if(!state.breakpoints[url]) {
      state.breakpoints[url] = [];
    }

    let bps = state.breakpoints[url];

    for(var i in bps) {
      if(bps[i].location.url === url &&
         bps[i].location.line === line) {
        found = true;
      }
    }

    if(found) {
      let bpClient = bps[line];
      bpClient.remove(() => {
        delete bps[line];
        render(state);
      });
    }
    else {
      activeThread.setBreakpoint(loc, (res, breakpointClient) => {
        bps[line] = breakpointClient;
        render(state);
      });
    }
  }
}

function initStores(client, threadClient) {
  client.addListener('newSource', addSource);
  threadClient.addListener('paused', onPaused);
  threadClient.addListener('resumed', onResumed);
  threadClient.getSources(res => {
    state.sources = res.sources;
    render(state);
  });
  activeThread = threadClient;
}

function render(state) {
  //dump('rendering ' + JSON.stringify(state, null, 2) + '\n');
  React.renderComponent(Root(state),
                        document.getElementById('debugger'));
}

// components

let Root = React.createClass({
  render: function() {
    return dom.div(
      { className: 'root' },
      dom.button({ onClick: togglePaused },
                 this.props.paused ? '->' : '||'),
      Sources({ sources: this.props.sources,
                onSelectSource: selectSource }),
      Editor({ selectedSource: this.props.selectedSourceData,
               breakpoints: this.props.breakpoints,
               onToggleBreakpoint: toggleBreakpoint })
    );
  }
});

let Editor = React.createClass({
  componentDidMount: function() {
    this.editor = new SourceEditor({
      mode: SourceEditor.modes.text,
      readOnly: true,
      lineNumbers: true,
      showAnnotationRuler: true,
      gutters: ['breakpoints'],
      contextMenu: 'sourceEditorContextMenu',
      enableCodeFolding: false
    });

    this.editor.on('gutterClick', (ev, line, button) => {
      if(button === 0) {
        this.props.onToggleBreakpoint(line);
      }
    });

    this.editor.appendTo(this.getDOMNode()).then(() => {
      this.editor.extend(DebuggerEditor);
    });
  },

  componentDidUpdate: function(prevProps) {
    let data = this.props.selectedSource;
    if(data.url !== prevProps.selectedSource.url) {
      this.editor.setText(data.text || '');
    }

    if(data.contentType === 'text/javascript') {
      this.editor.setMode(SourceEditor.modes.js);
    }
    else {
      this.editor.setMode(SourceEditor.modes.text);
    }

    this.editor.clearBreakpoints();

    if(data.url) {
      for(var i in this.props.breakpoints[data.url]) {
        let bps = this.props.breakpoints[data.url];
        this.editor.addBreakpoint(bps[i].location.line);
      }
    }

    if(data.debugLine) {
      this.editor.setDebugLocation(data.debugLine - 1);
    }
    else {
      this.editor.clearDebugLocation();
    }
  },

  render: function() {
    return dom.div({ id: 'editor' });
  }
});

let Sources = React.createClass({
  render: function() {
    return dom.ul(
      { id: 'sources' },
      this.props.sources.map(source => {
        return dom.li(
          { onClick: this.props.onSelectSource.bind(null, source) },
          source.url
        );
      })
    );
  }
});

/**
 * Called when the user select the tool tab.
 *
 * @param Toolbox toolbox
 *        The developer tools toolbox, containing all tools.
 * @param object target
 *        The local or remote target being debugged.
 * @return object
 *         A promise that should be resolved when the tool completes opening.
 */
function startup(toolbox, target) {
  let deferred = promise.defer();
  let { client } = target;

  //target.on('navigate', this._onTabNavigated);
  target.on('will-navigate', willNavigate);

  target.activeTab.attachThread({}, (res, threadClient) => {
    if(!threadClient) {
      deferred.reject(new Error('Couldn\'t attach to thread: ' + res.error));
    }

    initStores(client, threadClient);
    render(resetState());
    deferred.resolve();
  });

  return deferred.promise;
}

function willNavigate() {
  render(resetState());
}

/**
 * Called when the user closes the toolbox or disables the add-on.
 *
 * @return object
 *         A promise that should be resolved when the tool completes closing.
 */
function shutdown() {
  return promise.resolve();
}
