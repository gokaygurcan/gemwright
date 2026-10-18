
var createDotnetRuntime = (() => {
  var _scriptDir = import.meta.url;
  
  return (
async function(moduleArg = {}) {

// The Module object: Our interface to the outside world. We import
// and export values on it. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(Module) { ..generated code.. }
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to check if Module already exists (e.g. case 3 above).
// Substitution will be replaced with actual code on later stage of the build,
// this way Closure Compiler will not mangle it (e.g. case 4. above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module = moduleArg;

// Set up the promise that indicates the Module is initialized
var readyPromiseResolve, readyPromiseReject;
Module['ready'] = new Promise((resolve, reject) => {
  readyPromiseResolve = resolve;
  readyPromiseReject = reject;
});

// --pre-jses are emitted after the Module integration code, so that they can
// refer to Module (if they choose; they can also define Module)
if (_nativeModuleLoaded) throw new Error("Native module already loaded");
_nativeModuleLoaded = true;
createDotnetRuntime = Module = moduleArg(Module);


// Sometimes an existing Module object exists with properties
// meant to overwrite the default module functionality. Here
// we collect those properties and reapply _after_ we configure
// the current environment's defaults to avoid having to be so
// defensive during initialization.
var moduleOverrides = Object.assign({}, Module);

var arguments_ = [];
var thisProgram = './this.program';
var quit_ = (status, toThrow) => {
  throw toThrow;
};

// Determine the runtime environment we are in. You can customize this by
// setting the ENVIRONMENT setting at compile time (see settings.js).

// Attempt to auto-detect the environment
var ENVIRONMENT_IS_WEB = typeof window == 'object';
var ENVIRONMENT_IS_WORKER = typeof importScripts == 'function';
// N.b. Electron.js environment is simultaneously a NODE-environment, but
// also a web environment.
var ENVIRONMENT_IS_NODE = typeof process == 'object' && typeof process.versions == 'object' && typeof process.versions.node == 'string';
var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;

// Three configurations we can be running in:
// 1) We could be the application main() thread running in the main JS UI thread. (ENVIRONMENT_IS_WORKER == false and ENVIRONMENT_IS_PTHREAD == false)
// 2) We could be the application main() thread proxied to worker. (with Emscripten -sPROXY_TO_WORKER) (ENVIRONMENT_IS_WORKER == true, ENVIRONMENT_IS_PTHREAD == false)
// 3) We could be an application pthread running in a worker. (ENVIRONMENT_IS_WORKER == true and ENVIRONMENT_IS_PTHREAD == true)

// ENVIRONMENT_IS_PTHREAD=true will have been preset in worker.js. Make it false in the main runtime thread.
var ENVIRONMENT_IS_PTHREAD = Module['ENVIRONMENT_IS_PTHREAD'] || false;

// `/` should be present at the end if `scriptDirectory` is not empty
var scriptDirectory = '';
function locateFile(path) {
  if (Module['locateFile']) {
    return Module['locateFile'](path, scriptDirectory);
  }
  return scriptDirectory + path;
}

// Hooks that are implemented differently in different runtime environments.
var read_,
    readAsync,
    readBinary;

if (ENVIRONMENT_IS_NODE) {

  // `require()` is no-op in an ESM module, use `createRequire()` to construct
  // the require()` function.  This is only necessary for multi-environment
  // builds, `-sENVIRONMENT=node` emits a static import declaration instead.
  // TODO: Swap all `require()`'s with `import()`'s?
  const { createRequire } = await import('module');
  /** @suppress{duplicate} */
  var require = createRequire(import.meta.url);
  // These modules will usually be used on Node.js. Load them eagerly to avoid
  // the complexity of lazy-loading.
  var fs = require('fs');
  var nodePath = require('path');

  if (ENVIRONMENT_IS_WORKER) {
    scriptDirectory = nodePath.dirname(scriptDirectory) + '/';
  } else {
    // EXPORT_ES6 + ENVIRONMENT_IS_NODE always requires use of import.meta.url,
    // since there's no way getting the current absolute path of the module when
    // support for that is not available.
    scriptDirectory = require('url').fileURLToPath(new URL('./', import.meta.url)); // includes trailing slash
  }

read_ = (filename, binary) => {
  // We need to re-wrap `file://` strings to URLs. Normalizing isn't
  // necessary in that case, the path should already be absolute.
  filename = isFileURI(filename) ? new URL(filename) : nodePath.normalize(filename);
  return fs.readFileSync(filename, binary ? undefined : 'utf8');
};

readBinary = (filename) => {
  var ret = read_(filename, true);
  if (!ret.buffer) {
    ret = new Uint8Array(ret);
  }
  return ret;
};

readAsync = (filename, onload, onerror, binary = true) => {
  // See the comment in the `read_` function.
  filename = isFileURI(filename) ? new URL(filename) : nodePath.normalize(filename);
  fs.readFile(filename, binary ? undefined : 'utf8', (err, data) => {
    if (err) onerror(err);
    else onload(binary ? data.buffer : data);
  });
};
  if (!Module['thisProgram'] && process.argv.length > 1) {
    thisProgram = process.argv[1].replace(/\\/g, '/');
  }

  arguments_ = process.argv.slice(2);

  // MODULARIZE will export the module in the proper place outside, we don't need to export here

  quit_ = (status, toThrow) => {
    process.exitCode = status;
    throw toThrow;
  };

  global.Worker = require('worker_threads').Worker;

} else
if (ENVIRONMENT_IS_SHELL) {

  if (typeof read != 'undefined') {
    read_ = read;
  }

  readBinary = (f) => {
    if (typeof readbuffer == 'function') {
      return new Uint8Array(readbuffer(f));
    }
    let data = read(f, 'binary');
    assert(typeof data == 'object');
    return data;
  };

  readAsync = (f, onload, onerror) => {
    setTimeout(() => onload(readBinary(f)));
  };

  if (typeof clearTimeout == 'undefined') {
    globalThis.clearTimeout = (id) => {};
  }

  if (typeof setTimeout == 'undefined') {
    // spidermonkey lacks setTimeout but we use it above in readAsync.
    globalThis.setTimeout = (f) => (typeof f == 'function') ? f() : abort();
  }

  if (typeof scriptArgs != 'undefined') {
    arguments_ = scriptArgs;
  } else if (typeof arguments != 'undefined') {
    arguments_ = arguments;
  }

  if (typeof quit == 'function') {
    quit_ = (status, toThrow) => {
      // Unlike node which has process.exitCode, d8 has no such mechanism. So we
      // have no way to set the exit code and then let the program exit with
      // that code when it naturally stops running (say, when all setTimeouts
      // have completed). For that reason, we must call `quit` - the only way to
      // set the exit code - but quit also halts immediately.  To increase
      // consistency with node (and the web) we schedule the actual quit call
      // using a setTimeout to give the current stack and any exception handlers
      // a chance to run.  This enables features such as addOnPostRun (which
      // expected to be able to run code after main returns).
      setTimeout(() => {
        if (!(toThrow instanceof ExitStatus)) {
          let toLog = toThrow;
          if (toThrow && typeof toThrow == 'object' && toThrow.stack) {
            toLog = [toThrow, toThrow.stack];
          }
          err(`exiting due to exception: ${toLog}`);
        }
        quit(status);
      });
      throw toThrow;
    };
  }

  if (typeof print != 'undefined') {
    // Prefer to use print/printErr where they exist, as they usually work better.
    if (typeof console == 'undefined') console = /** @type{!Console} */({});
    console.log = /** @type{!function(this:Console, ...*): undefined} */ (print);
    console.warn = console.error = /** @type{!function(this:Console, ...*): undefined} */ (typeof printErr != 'undefined' ? printErr : print);
  }

} else

// Note that this includes Node.js workers when relevant (pthreads is enabled).
// Node.js workers are detected as a combination of ENVIRONMENT_IS_WORKER and
// ENVIRONMENT_IS_NODE.
if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
  if (ENVIRONMENT_IS_WORKER) { // Check worker, not web, since window could be polyfilled
    scriptDirectory = self.location.href;
  } else if (typeof document != 'undefined' && document.currentScript) { // web
    scriptDirectory = document.currentScript.src;
  }
  // When MODULARIZE, this JS may be executed later, after document.currentScript
  // is gone, so we saved it, and we use it here instead of any other info.
  if (_scriptDir) {
    scriptDirectory = _scriptDir;
  }
  // blob urls look like blob:http://site.com/etc/etc and we cannot infer anything from them.
  // otherwise, slice off the final part of the url to find the script directory.
  // if scriptDirectory does not contain a slash, lastIndexOf will return -1,
  // and scriptDirectory will correctly be replaced with an empty string.
  // If scriptDirectory contains a query (starting with ?) or a fragment (starting with #),
  // they are removed because they could contain a slash.
  if (scriptDirectory.startsWith('blob:')) {
    scriptDirectory = '';
  } else {
    scriptDirectory = scriptDirectory.substr(0, scriptDirectory.replace(/[?#].*/, '').lastIndexOf('/')+1);
  }

  // Differentiate the Web Worker from the Node Worker case, as reading must
  // be done differently.
  if (!ENVIRONMENT_IS_NODE)
  {
read_ = (url) => {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.send(null);
    return xhr.responseText;
  }

  if (ENVIRONMENT_IS_WORKER) {
    readBinary = (url) => {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.responseType = 'arraybuffer';
      xhr.send(null);
      return new Uint8Array(/** @type{!ArrayBuffer} */(xhr.response));
    };
  }

  readAsync = (url, onload, onerror) => {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      if (xhr.status == 200 || (xhr.status == 0 && xhr.response)) { // file URLs can return 0
        onload(xhr.response);
        return;
      }
      onerror();
    };
    xhr.onerror = onerror;
    xhr.send(null);
  }

  }
} else
{
}

if (ENVIRONMENT_IS_NODE) {
  // Polyfill the performance object, which emscripten pthreads support
  // depends on for good timing.
  if (typeof performance == 'undefined') {
    global.performance = require('perf_hooks').performance;
  }
}

// Set up the out() and err() hooks, which are how we can print to stdout or
// stderr, respectively.
// Normally just binding console.log/console.error here works fine, but
// under node (with workers) we see missing/out-of-order messages so route
// directly to stdout and stderr.
// See https://github.com/emscripten-core/emscripten/issues/14804
var defaultPrint = console.log.bind(console);
var defaultPrintErr = console.error.bind(console);
if (ENVIRONMENT_IS_NODE) {
  defaultPrint = (...args) => fs.writeSync(1, args.join(' ') + '\n');
  defaultPrintErr = (...args) => fs.writeSync(2, args.join(' ') + '\n');
}
var out = Module['print'] || defaultPrint;
var err = Module['printErr'] || defaultPrintErr;

// Merge back in the overrides
Object.assign(Module, moduleOverrides);
// Free the object hierarchy contained in the overrides, this lets the GC
// reclaim data used.
moduleOverrides = null;

// Emit code to handle expected values on the Module object. This applies Module.x
// to the proper local x. This has two benefits: first, we only emit it if it is
// expected to arrive, and second, by using a local everywhere else that can be
// minified.

if (Module['arguments']) arguments_ = Module['arguments'];

if (Module['thisProgram']) thisProgram = Module['thisProgram'];

if (Module['quit']) quit_ = Module['quit'];

// perform assertions in shell.js after we set up out() and err(), as otherwise if an assertion fails it cannot print the message

// === Preamble library stuff ===

// Documentation for the public APIs defined in this file must be updated in:
//    site/source/docs/api_reference/preamble.js.rst
// A prebuilt local version of the documentation is available at:
//    site/build/text/docs/api_reference/preamble.js.txt
// You can also build docs locally as HTML or other formats in site/
// An online HTML version (which may be of a different version of Emscripten)
//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html

var wasmBinary; 
if (Module['wasmBinary']) wasmBinary = Module['wasmBinary'];

// Copied from https://github.com/strophe/strophejs/blob/e06d027/src/polyfills.js#L149

// This code was written by Tyler Akins and has been placed in the
// public domain.  It would be nice if you left this header intact.
// Base64 code from Tyler Akins -- http://rumkin.com

if (typeof atob == 'undefined') {
  if (typeof global != 'undefined' && typeof globalThis == 'undefined') {
    globalThis = global;
  }

  /**
   * Decodes a base64 string.
   * @param {string} input The string to decode.
   */
  globalThis.atob = function(input) {
    var keyStr = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

    var output = '';
    var chr1, chr2, chr3;
    var enc1, enc2, enc3, enc4;
    var i = 0;
    // remove all characters that are not A-Z, a-z, 0-9, +, /, or =
    input = input.replace(/[^A-Za-z0-9\+\/\=]/g, '');
    do {
      enc1 = keyStr.indexOf(input.charAt(i++));
      enc2 = keyStr.indexOf(input.charAt(i++));
      enc3 = keyStr.indexOf(input.charAt(i++));
      enc4 = keyStr.indexOf(input.charAt(i++));

      chr1 = (enc1 << 2) | (enc2 >> 4);
      chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
      chr3 = ((enc3 & 3) << 6) | enc4;

      output = output + String.fromCharCode(chr1);

      if (enc3 !== 64) {
        output = output + String.fromCharCode(chr2);
      }
      if (enc4 !== 64) {
        output = output + String.fromCharCode(chr3);
      }
    } while (i < input.length);
    return output;
  };
}
// Converts a string of base64 into a byte array (Uint8Array).
function intArrayFromBase64(s) {
  if (typeof ENVIRONMENT_IS_NODE != 'undefined' && ENVIRONMENT_IS_NODE) {
    var buf = Buffer.from(s, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  }

  var decoded = atob(s);
  var bytes = new Uint8Array(decoded.length);
  for (var i = 0 ; i < decoded.length ; ++i) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

// If filename is a base64 data URI, parses and returns data (Buffer on node,
// Uint8Array otherwise). If filename is not a base64 data URI, returns undefined.
function tryParseAsDataURI(filename) {
  if (!isDataURI(filename)) {
    return;
  }

  return intArrayFromBase64(filename.slice(dataURIPrefix.length));
}
// Wasm globals

var wasmMemory;

// For sending to workers.
var wasmModule;

//========================================
// Runtime essentials
//========================================

// whether we are quitting the application. no code should run after this.
// set in exit() and abort()
var ABORT = false;

// set by exit() and abort().  Passed to 'onExit' handler.
// NOTE: This is also used as the process return code code in shell environments
// but only when noExitRuntime is false.
var EXITSTATUS;

// In STRICT mode, we only define assert() when ASSERTIONS is set.  i.e. we
// don't define it at all in release modes.  This matches the behaviour of
// MINIMAL_RUNTIME.
// TODO(sbc): Make this the default even without STRICT enabled.
/** @type {function(*, string=)} */
function assert(condition, text) {
  if (!condition) {
    // This build was created without ASSERTIONS defined.  `assert()` should not
    // ever be called in this configuration but in case there are callers in
    // the wild leave this simple abort() implementation here for now.
    abort(text);
  }
}

// Memory management

var HEAP,
/** @type {!Int8Array} */
  HEAP8,
/** @type {!Uint8Array} */
  HEAPU8,
/** @type {!Int16Array} */
  HEAP16,
/** @type {!Uint16Array} */
  HEAPU16,
/** @type {!Int32Array} */
  HEAP32,
/** @type {!Uint32Array} */
  HEAPU32,
/** @type {!Float32Array} */
  HEAPF32,
/* BigInt64Array type is not correctly defined in closure
/** not-@type {!BigInt64Array} */
  HEAP64,
/* BigUInt64Array type is not correctly defined in closure
/** not-t@type {!BigUint64Array} */
  HEAPU64,
/** @type {!Float64Array} */
  HEAPF64;

function updateMemoryViews() {
  var b = wasmMemory.buffer;
  Module['HEAP8'] = HEAP8 = new Int8Array(b);
  Module['HEAP16'] = HEAP16 = new Int16Array(b);
  Module['HEAPU8'] = HEAPU8 = new Uint8Array(b);
  Module['HEAPU16'] = HEAPU16 = new Uint16Array(b);
  Module['HEAP32'] = HEAP32 = new Int32Array(b);
  Module['HEAPU32'] = HEAPU32 = new Uint32Array(b);
  Module['HEAPF32'] = HEAPF32 = new Float32Array(b);
  Module['HEAPF64'] = HEAPF64 = new Float64Array(b);
  Module['HEAP64'] = HEAP64 = new BigInt64Array(b);
  Module['HEAPU64'] = HEAPU64 = new BigUint64Array(b);
}
// In non-standalone/normal mode, we create the memory here.
// Create the wasm memory. (Note: this only applies if IMPORTED_MEMORY is defined)

var INITIAL_MEMORY = Module['INITIAL_MEMORY'] || 2147483648;

  
// check for full engine support (use string 'subarray' to avoid closure compiler confusion)

if (ENVIRONMENT_IS_PTHREAD) {
  wasmMemory = Module['wasmMemory'];
} else {

  if (Module['wasmMemory']) {
    wasmMemory = Module['wasmMemory'];
  } else
  {
    wasmMemory = new WebAssembly.Memory({
      'initial': INITIAL_MEMORY / 65536,
      'maximum': INITIAL_MEMORY / 65536,
      'shared': true,
    });
    if (!(wasmMemory.buffer instanceof SharedArrayBuffer)) {
      err('requested a shared WebAssembly.Memory but the returned buffer is not a SharedArrayBuffer, indicating that while the browser has SharedArrayBuffer it does not have WebAssembly threads support - you may need to set a flag');
      if (ENVIRONMENT_IS_NODE) {
        err('(on node you may need: --experimental-wasm-threads --experimental-wasm-bulk-memory and/or recent version)');
      }
      throw Error('bad memory');
    }
  }

}

updateMemoryViews();

// If the user provides an incorrect length, just use that length instead rather than providing the user to
// specifically provide the memory length with Module['INITIAL_MEMORY'].
INITIAL_MEMORY = wasmMemory.buffer.byteLength;

var __ATPRERUN__  = []; // functions called before the runtime is initialized
var __ATINIT__    = []; // functions called during startup
var __ATEXIT__    = []; // functions called during shutdown
var __ATPOSTRUN__ = []; // functions called after the main() is called

var runtimeInitialized = false;

var runtimeExited = false;

function preRun() {
  if (Module['preRun']) {
    if (typeof Module['preRun'] == 'function') Module['preRun'] = [Module['preRun']];
    while (Module['preRun'].length) {
      addOnPreRun(Module['preRun'].shift());
    }
  }
  callRuntimeCallbacks(__ATPRERUN__);
}

function initRuntime() {
  runtimeInitialized = true;

  if (ENVIRONMENT_IS_PTHREAD) return;

  
if (!Module['noFSInit'] && !FS.init.initialized)
  FS.init();
FS.ignorePermissions = false;

TTY.init();
SOCKFS.root = FS.mount(SOCKFS, {}, null);
  callRuntimeCallbacks(__ATINIT__);
}

function exitRuntime() {
  if (ENVIRONMENT_IS_PTHREAD) return; // PThreads reuse the runtime from the main thread.
  ___funcs_on_exit(); // Native atexit() functions
  callRuntimeCallbacks(__ATEXIT__);
  FS.quit();
TTY.shutdown();
IDBFS.quit();
  PThread.terminateAllThreads();
  runtimeExited = true;
}

function postRun() {
  if (ENVIRONMENT_IS_PTHREAD) return; // PThreads reuse the runtime from the main thread.

  if (Module['postRun']) {
    if (typeof Module['postRun'] == 'function') Module['postRun'] = [Module['postRun']];
    while (Module['postRun'].length) {
      addOnPostRun(Module['postRun'].shift());
    }
  }

  callRuntimeCallbacks(__ATPOSTRUN__);
}

function addOnPreRun(cb) {
  __ATPRERUN__.unshift(cb);
}

function addOnInit(cb) {
  __ATINIT__.unshift(cb);
}

function addOnExit(cb) {
  __ATEXIT__.unshift(cb);
}

function addOnPostRun(cb) {
  __ATPOSTRUN__.unshift(cb);
}

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/imul

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/fround

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/clz32

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/trunc

// A counter of dependencies for calling run(). If we need to
// do asynchronous work before running, increment this and
// decrement it. Incrementing must happen in a place like
// Module.preRun (used by emcc to add file preloading).
// Note that you can add dependencies in preRun, even though
// it happens right before run - run will be postponed until
// the dependencies are met.
var runDependencies = 0;
var runDependencyWatcher = null;
var dependenciesFulfilled = null; // overridden to take different actions when all run dependencies are fulfilled

function getUniqueRunDependency(id) {
  return id;
}

function addRunDependency(id) {
  runDependencies++;

  Module['monitorRunDependencies']?.(runDependencies);

}

function removeRunDependency(id) {
  runDependencies--;

  Module['monitorRunDependencies']?.(runDependencies);

  if (runDependencies == 0) {
    if (runDependencyWatcher !== null) {
      clearInterval(runDependencyWatcher);
      runDependencyWatcher = null;
    }
    if (dependenciesFulfilled) {
      var callback = dependenciesFulfilled;
      dependenciesFulfilled = null;
      callback(); // can add another dependenciesFulfilled
    }
  }
}

/** @param {string|number=} what */
function abort(what) {
  Module['onAbort']?.(what);

  what = 'Aborted(' + what + ')';
  // TODO(sbc): Should we remove printing and leave it up to whoever
  // catches the exception?
  err(what);

  ABORT = true;
  EXITSTATUS = 1;

  what += '. Build with -sASSERTIONS for more info.';

  // Use a wasm runtime error, because a JS error might be seen as a foreign
  // exception, which means we'd run destructors on it. We need the error to
  // simply make the program stop.
  // FIXME This approach does not work in Wasm EH because it currently does not assume
  // all RuntimeErrors are from traps; it decides whether a RuntimeError is from
  // a trap or not based on a hidden field within the object. So at the moment
  // we don't have a way of throwing a wasm trap from JS. TODO Make a JS API that
  // allows this in the wasm spec.

  // Suppress closure compiler warning here. Closure compiler's builtin extern
  // definition for WebAssembly.RuntimeError claims it takes no arguments even
  // though it can.
  // TODO(https://github.com/google/closure-compiler/pull/3913): Remove if/when upstream closure gets fixed.
  // See above, in the meantime, we resort to wasm code for trapping.
  //
  // In case abort() is called before the module is initialized, wasmExports
  // and its exported '__trap' function is not available, in which case we throw
  // a RuntimeError.
  //
  // We trap instead of throwing RuntimeError to prevent infinite-looping in
  // Wasm EH code (because RuntimeError is considered as a foreign exception and
  // caught by 'catch_all'), but in case throwing RuntimeError is fine because
  // the module has not even been instantiated, even less running.
  if (runtimeInitialized) {
    ___trap();
  }
  /** @suppress {checkTypes} */
  var e = new WebAssembly.RuntimeError(what);

  readyPromiseReject(e);
  // Throw the error whether or not MODULARIZE is set because abort is used
  // in code paths apart from instantiation where an exception is expected
  // to be thrown when abort is called.
  throw e;
}

// Prefix of data URIs emitted by SINGLE_FILE and related options.
var dataURIPrefix = 'data:application/octet-stream;base64,';

/**
 * Indicates whether filename is a base64 data URI.
 * @noinline
 */
var isDataURI = (filename) => filename.startsWith(dataURIPrefix);

/**
 * Indicates whether filename is delivered via file protocol (as opposed to http/https)
 * @noinline
 */
var isFileURI = (filename) => filename.startsWith('file://');
var wasmBinaryFile;
if (Module['locateFile']) {
  wasmBinaryFile = 'dotnet.native.wasm';
  if (!isDataURI(wasmBinaryFile)) {
    wasmBinaryFile = locateFile(wasmBinaryFile);
  }
} else {
  if (ENVIRONMENT_IS_SHELL)
    wasmBinaryFile = 'dotnet.native.wasm';
  else
  // Use bundler-friendly `new URL(..., import.meta.url)` pattern; works in browsers too.
  wasmBinaryFile = new URL('dotnet.native.wasm', import.meta.url).href;
}

function getBinarySync(file) {
  if (file == wasmBinaryFile && wasmBinary) {
    return new Uint8Array(wasmBinary);
  }
  if (readBinary) {
    return readBinary(file);
  }
  throw 'both async and sync fetching of the wasm failed';
}

function getBinaryPromise(binaryFile) {
  // If we don't have the binary yet, try to load it asynchronously.
  // Fetch has some additional restrictions over XHR, like it can't be used on a file:// url.
  // See https://github.com/github/fetch/pull/92#issuecomment-140665932
  // Cordova or Electron apps are typically loaded from a file:// url.
  // So use fetch if it is available and the url is not a file, otherwise fall back to XHR.
  if (!wasmBinary
      && (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER)) {
    if (typeof fetch == 'function'
      && !isFileURI(binaryFile)
    ) {
      return fetch(binaryFile, { credentials: 'same-origin' }).then((response) => {
        if (!response['ok']) {
          throw `failed to load wasm binary file at '${binaryFile}'`;
        }
        return response['arrayBuffer']();
      }).catch(() => getBinarySync(binaryFile));
    }
    else if (readAsync) {
      // fetch is not available or url is file => try XHR (readAsync uses XHR internally)
      return new Promise((resolve, reject) => {
        readAsync(binaryFile, (response) => resolve(new Uint8Array(/** @type{!ArrayBuffer} */(response))), reject)
      });
    }
  }

  // Otherwise, getBinarySync should be able to get it synchronously
  return Promise.resolve().then(() => getBinarySync(binaryFile));
}

function instantiateArrayBuffer(binaryFile, imports, receiver) {
  return getBinaryPromise(binaryFile).then((binary) => {
    return WebAssembly.instantiate(binary, imports);
  }).then(receiver, (reason) => {
    err(`failed to asynchronously prepare wasm: ${reason}`);

    abort(reason);
  });
}

function instantiateAsync(binary, binaryFile, imports, callback) {
  if (!binary &&
      typeof WebAssembly.instantiateStreaming == 'function' &&
      !isDataURI(binaryFile) &&
      // Don't use streaming for file:// delivered objects in a webview, fetch them synchronously.
      !isFileURI(binaryFile) &&
      // Avoid instantiateStreaming() on Node.js environment for now, as while
      // Node.js v18.1.0 implements it, it does not have a full fetch()
      // implementation yet.
      //
      // Reference:
      //   https://github.com/emscripten-core/emscripten/pull/16917
      !ENVIRONMENT_IS_NODE &&
      typeof fetch == 'function') {
    return fetch(binaryFile, { credentials: 'same-origin' }).then((response) => {
      // Suppress closure warning here since the upstream definition for
      // instantiateStreaming only allows Promise<Repsponse> rather than
      // an actual Response.
      // TODO(https://github.com/google/closure-compiler/pull/3913): Remove if/when upstream closure is fixed.
      /** @suppress {checkTypes} */
      var result = WebAssembly.instantiateStreaming(response, imports);

      return result.then(
        callback,
        function(reason) {
          // We expect the most common failure cause to be a bad MIME type for the binary,
          // in which case falling back to ArrayBuffer instantiation should work.
          err(`wasm streaming compile failed: ${reason}`);
          err('falling back to ArrayBuffer instantiation');
          return instantiateArrayBuffer(binaryFile, imports, callback);
        });
    });
  }
  return instantiateArrayBuffer(binaryFile, imports, callback);
}

// Create the wasm instance.
// Receives the wasm imports, returns the exports.
function createWasm() {
  // prepare imports
  var info = {
    'env': wasmImports,
    'wasi_snapshot_preview1': wasmImports,
  };
  // Load the wasm module and create an instance of using native support in the JS engine.
  // handle a generated wasm instance, receiving its exports and
  // performing other necessary setup
  /** @param {WebAssembly.Module=} module*/
  function receiveInstance(instance, module) {
    wasmExports = instance.exports;

    Module['wasmExports'] = wasmExports;

    registerTLSInit(wasmExports['_emscripten_tls_init']);

    wasmTable = wasmExports['__indirect_function_table'];
    

    addOnInit(wasmExports['__wasm_call_ctors']);

    // We now have the Wasm module loaded up, keep a reference to the compiled module so we can post it to the workers.
    wasmModule = module;
    removeRunDependency('wasm-instantiate');
    return wasmExports;
  }
  // wait for the pthread pool (if any)
  addRunDependency('wasm-instantiate');

  // Prefer streaming instantiation if available.
  function receiveInstantiationResult(result) {
    // 'result' is a ResultObject object which has both the module and instance.
    // receiveInstance() will swap in the exports (to Module.asm) so they can be called
    receiveInstance(result['instance'], result['module']);
  }

  // User shell pages can write their own Module.instantiateWasm = function(imports, successCallback) callback
  // to manually instantiate the Wasm module themselves. This allows pages to
  // run the instantiation parallel to any other async startup actions they are
  // performing.
  // Also pthreads and wasm workers initialize the wasm instance through this
  // path.
  if (Module['instantiateWasm']) {

    try {
      return Module['instantiateWasm'](info, receiveInstance);
    } catch(e) {
      err(`Module.instantiateWasm callback failed with error: ${e}`);
        // If instantiation fails, reject the module ready promise.
        readyPromiseReject(e);
    }
  }

  // If instantiation fails, reject the module ready promise.
  instantiateAsync(wasmBinary, wasmBinaryFile, info, receiveInstantiationResult).catch(readyPromiseReject);
  return {}; // no exports yet; we'll fill them in later
}

// === Body ===

var ASM_CONSTS = {
  17381696: () => { if (typeof globalThis.__wasm_flush_idbfs === 'function') { try { globalThis.__wasm_flush_idbfs(); } catch (e) { console.warn('[wasm_flush_idbfs] threw:', e); } } },  
 17381862: ($0, $1, $2, $3, $4, $5) => { if (typeof globalThis.__wasm_play_pcm === 'function') { try { return globalThis.__wasm_play_pcm($0, $1, $2, $3, $4, $5); } catch (e) { console.warn('[wasm_play_pcm] threw:', e); } } return 0; },  
 17382058: ($0, $1, $2, $3) => { if (typeof globalThis.__wasm_play_music === 'function') { try { return globalThis.__wasm_play_music($0, $1, $2, $3); } catch (e) { console.warn('[wasm_play_music] threw:', e); } } return 0; },  
 17382252: ($0) => { if (typeof globalThis.__wasm_stop_sound === 'function') { try { globalThis.__wasm_stop_sound($0); } catch (e) { console.warn('[wasm_stop_sound] threw:', e); } } },  
 17382417: ($0, $1) => { if (typeof globalThis.__wasm_set_sound_volume === 'function') { try { globalThis.__wasm_set_sound_volume($0, $1); } catch (e) { } } },  
 17382553: ($0) => { if (typeof globalThis.__uo_signal === 'function') { try { globalThis.__uo_signal(UTF8ToString($0)); } catch (e) { } } },  
 17382675: ($0) => { try { if (typeof globalThis.__uo_signal === 'function') { globalThis.__uo_signal(UTF8ToString($0)); } } catch (e) { } try { _free($0); } catch (e) { } },  
 17382830: ($0, $1) => { if (typeof globalThis.__wasm_clipboard_set === 'function') { try { globalThis.__wasm_clipboard_set(UTF8ToString($0, $1)); } catch (e) { console.warn('[wasm_clipboard_set] threw:', e); } } },  
 17383022: ($0, $1) => { if (typeof globalThis.__wasm_clipboard_get !== 'function') return 0; var s; try { s = globalThis.__wasm_clipboard_get(); } catch (e) { console.warn('[wasm_clipboard_get] threw:', e); return 0; } if (typeof s !== 'string' || s.length === 0) return 0; var enc = new TextEncoder().encode(s); var n = enc.length < $1 ? enc.length : $1; HEAPU8.set(enc.subarray(0, n), $0); return n; },  
 17383404: ($0, $1, $2) => { if (typeof globalThis.__wasm_play_music_url === 'function') { try { return globalThis.__wasm_play_music_url(UTF8ToString($0), $1, $2); } catch (e) { console.warn('[wasm_play_music_url] threw:', e); } } return 0; },  
 17383620: () => { if (typeof(Module['SDL3']) === 'undefined') { Module['SDL3'] = {}; } var SDL3 = Module['SDL3']; if (typeof(SDL3.JSVarToCPtr) === 'undefined') { SDL3.JSVarToCPtr = function(v) { return v; }; } if (typeof(SDL3.CPtrToHeap32Index) === 'undefined') { SDL3.CPtrToHeap32Index = function(ptr) { return ptr >>> 2; }; } },  
 17383934: ($0) => { var str = UTF8ToString($0) + '\n\n' + 'Abort/Retry/Ignore/AlwaysIgnore? [ariA] :'; var reply = window.prompt(str, "i"); if (reply === null) { reply = "i"; } return reply.length === 1 ? reply.charCodeAt(0) : -1; },  
 17384149: () => { Module['SDL3'].dummy_audio = {}; Module['SDL3'].dummy_audio.timers = []; Module['SDL3'].dummy_audio.timers[0] = undefined; Module['SDL3'].dummy_audio.timers[1] = undefined; },  
 17384326: ($0, $1, $2, $3, $4) => { var a = Module['SDL3'].dummy_audio; if (a.timers[$0] !== undefined) { clearInterval(a.timers[$0]); } a.timers[$0] = setInterval(function() { dynCall('vi', $3, [$4]); }, ($1 / $2) * 1000); },  
 17384518: ($0) => { var a = Module['SDL3'].dummy_audio; if (a.timers[$0] !== undefined) { clearInterval(a.timers[$0]); } a.timers[$0] = undefined; },  
 17384649: ($0) => { var parms = new URLSearchParams(window.location.search); for (const [key, value] of parms) { if (key.startsWith("SDL_")) { var ckey = stringToNewUTF8(key); var cvalue = stringToNewUTF8(value); if ((ckey != 0) && (cvalue != 0)) { dynCall('iiii', $0, [ckey, cvalue, 1]); } _SDL3_renamed_Emscripten_force_free(ckey); _SDL3_renamed_Emscripten_force_free(cvalue); } } },  
 17385016: ($0) => { window.open(UTF8ToString($0), "_blank") },  
 17385056: () => { if (typeof(AudioContext) !== 'undefined') { return true; } else if (typeof(webkitAudioContext) !== 'undefined') { return true; } return false; },  
 17385203: () => { if ((typeof(navigator.mediaDevices) !== 'undefined') && (typeof(navigator.mediaDevices.getUserMedia) !== 'undefined')) { return true; } else if (typeof(navigator.webkitGetUserMedia) !== 'undefined') { return true; } return false; },  
 17385437: () => { var SDL3 = Module['SDL3']; if (typeof(SDL3.audio_playback) === 'undefined') { SDL3.audio_playback = {}; } if (typeof(SDL3.audio_recording) === 'undefined') { SDL3.audio_recording = {}; } if (!SDL3.audioContext) { if (typeof(AudioContext) !== 'undefined') { SDL3.audioContext = new AudioContext(); } else if (typeof(webkitAudioContext) !== 'undefined') { SDL3.audioContext = new webkitAudioContext(); } if (SDL3.audioContext) { if ((typeof navigator.userActivation) === 'undefined') { autoResumeAudioContext(SDL3.audioContext); } } } return (SDL3.audioContext !== undefined); },  
 17386016: () => { return Module['SDL3'].audioContext.sampleRate; },  
 17386067: ($0, $1, $2, $3) => { var SDL3 = Module['SDL3']; var have_microphone = function(stream) { if (SDL3.audio_recording.silenceTimer !== undefined) { clearInterval(SDL3.audio_recording.silenceTimer); SDL3.audio_recording.silenceTimer = undefined; SDL3.audio_recording.silenceBuffer = undefined } SDL3.audio_recording.mediaStreamNode = SDL3.audioContext.createMediaStreamSource(stream); SDL3.audio_recording.scriptProcessorNode = SDL3.audioContext.createScriptProcessor($1, $0, 1); SDL3.audio_recording.scriptProcessorNode.onaudioprocess = function(audioProcessingEvent) { if ((SDL3 === undefined) || (SDL3.audio_recording === undefined)) { return; } audioProcessingEvent.outputBuffer.getChannelData(0).fill(0.0); SDL3.audio_recording.currentRecordingBuffer = audioProcessingEvent.inputBuffer; dynCall('ip', $2, [$3]); }; SDL3.audio_recording.mediaStreamNode.connect(SDL3.audio_recording.scriptProcessorNode); SDL3.audio_recording.scriptProcessorNode.connect(SDL3.audioContext.destination); SDL3.audio_recording.stream = stream; }; var no_microphone = function(error) { }; SDL3.audio_recording.silenceBuffer = SDL3.audioContext.createBuffer($0, $1, SDL3.audioContext.sampleRate); SDL3.audio_recording.silenceBuffer.getChannelData(0).fill(0.0); var silence_callback = function() { SDL3.audio_recording.currentRecordingBuffer = SDL3.audio_recording.silenceBuffer; dynCall('ip', $2, [$3]); }; SDL3.audio_recording.silenceTimer = setInterval(silence_callback, ($1 / SDL3.audioContext.sampleRate) * 1000); if ((navigator.mediaDevices !== undefined) && (navigator.mediaDevices.getUserMedia !== undefined)) { navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(have_microphone).catch(no_microphone); } else if (navigator.webkitGetUserMedia !== undefined) { navigator.webkitGetUserMedia({ audio: true, video: false }, have_microphone, no_microphone); } },  
 17387908: ($0, $1, $2, $3) => { var SDL3 = Module['SDL3']; SDL3.audio_playback.scriptProcessorNode = SDL3.audioContext['createScriptProcessor']($1, 0, $0); SDL3.audio_playback.scriptProcessorNode['onaudioprocess'] = function (e) { if ((SDL3 === undefined) || (SDL3.audio_playback === undefined)) { return; } if (SDL3.audio_playback.silenceTimer !== undefined) { clearInterval(SDL3.audio_playback.silenceTimer); SDL3.audio_playback.silenceTimer = undefined; SDL3.audio_playback.silenceBuffer = undefined; } SDL3.audio_playback.currentPlaybackBuffer = e['outputBuffer']; dynCall('ip', $2, [$3]); }; SDL3.audio_playback.scriptProcessorNode['connect'](SDL3.audioContext['destination']); if (SDL3.audioContext.state === 'suspended') { SDL3.audio_playback.silenceBuffer = SDL3.audioContext.createBuffer($0, $1, SDL3.audioContext.sampleRate); SDL3.audio_playback.silenceBuffer.getChannelData(0).fill(0.0); var silence_callback = function() { if ((typeof navigator.userActivation) !== 'undefined') { if (navigator.userActivation.hasBeenActive) { SDL3.audioContext.resume(); } } SDL3.audio_playback.currentPlaybackBuffer = SDL3.audio_playback.silenceBuffer; dynCall('ip', $2, [$3]); SDL3.audio_playback.currentPlaybackBuffer = undefined; }; SDL3.audio_playback.silenceTimer = setInterval(silence_callback, ($1 / SDL3.audioContext.sampleRate) * 1000); } },  
 17389224: ($0) => { var SDL3 = Module['SDL3']; if ($0) { if (SDL3.audio_recording.silenceTimer !== undefined) { clearInterval(SDL3.audio_recording.silenceTimer); } if (SDL3.audio_recording.stream !== undefined) { var tracks = SDL3.audio_recording.stream.getAudioTracks(); for (var i = 0; i < tracks.length; i++) { SDL3.audio_recording.stream.removeTrack(tracks[i]); } } if (SDL3.audio_recording.scriptProcessorNode !== undefined) { SDL3.audio_recording.scriptProcessorNode.onaudioprocess = function(audioProcessingEvent) {}; SDL3.audio_recording.scriptProcessorNode.disconnect(); } if (SDL3.audio_recording.mediaStreamNode !== undefined) { SDL3.audio_recording.mediaStreamNode.disconnect(); } SDL3.audio_recording = undefined; } else { if (SDL3.audio_playback.scriptProcessorNode != undefined) { SDL3.audio_playback.scriptProcessorNode.disconnect(); } if (SDL3.audio_playback.silenceTimer !== undefined) { clearInterval(SDL3.audio_playback.silenceTimer); } SDL3.audio_playback = undefined; } if ((SDL3.audioContext !== undefined) && (SDL3.audio_playback === undefined) && (SDL3.audio_recording === undefined)) { SDL3.audioContext.close(); SDL3.audioContext = undefined; } },  
 17390380: ($0, $1) => { var SDL3 = Module['SDL3']; var buf = SDL3.CPtrToHeap32Index($0); var numChannels = SDL3.audio_playback.currentPlaybackBuffer['numberOfChannels']; for (var c = 0; c < numChannels; ++c) { var channelData = SDL3.audio_playback.currentPlaybackBuffer['getChannelData'](c); if (channelData.length != $1) { throw 'Web Audio playback buffer length mismatch! Destination size: ' + channelData.length + ' samples vs expected ' + $1 + ' samples!'; } for (var j = 0; j < $1; ++j) { channelData[j] = HEAPF32[buf + (j * numChannels + c)]; } } },  
 17390913: ($0, $1) => { var SDL3 = Module['SDL3']; var numChannels = SDL3.audio_recording.currentRecordingBuffer.numberOfChannels; for (var c = 0; c < numChannels; ++c) { var channelData = SDL3.audio_recording.currentRecordingBuffer.getChannelData(c); if (channelData.length != $1) { throw 'Web Audio recording buffer length mismatch! Destination size: ' + channelData.length + ' samples vs expected ' + $1 + ' samples!'; } if (numChannels == 1) { for (var j = 0; j < $1; ++j) { setValue($0 + (j * 4), channelData[j], 'float'); } } else { for (var j = 0; j < $1; ++j) { setValue($0 + (((j * numChannels) + c) * 4), channelData[j], 'float'); } } } },  
 17391540: () => { Module['SDL3'].camera = {}; },  
 17391572: () => { return (navigator.mediaDevices === undefined) ? 0 : 1; },  
 17391631: ($0, $1, $2, $3, $4) => { const device = $0; const w = $1; const h = $2; const framerate_numerator = $3; const framerate_denominator = $4; const outcome = Module._SDL3_renamed_SDLEmscriptenCameraPermissionOutcome; const iterate = Module._SDL3_renamed_SDLEmscriptenThreadIterate; const constraints = {}; if ((w <= 0) || (h <= 0)) { constraints.video = true; } else { constraints.video = {}; constraints.video.width = w; constraints.video.height = h; } if ((framerate_numerator > 0) && (framerate_denominator > 0)) { var fps = framerate_numerator / framerate_denominator; constraints.video.frameRate = { ideal: fps }; } function grabNextCameraFrame() { const SDL3 = Module['SDL3']; if ((typeof(SDL3) === 'undefined') || (typeof(SDL3.camera) === 'undefined') || (typeof(SDL3.camera.stream) === 'undefined')) { return; } const nextframems = SDL3.camera.next_frame_time; const now = performance.now(); if (now >= nextframems) { iterate(device); while (SDL3.camera.next_frame_time < now) { SDL3.camera.next_frame_time += SDL3.camera.fpsincrms; } } requestAnimationFrame(grabNextCameraFrame); } navigator.mediaDevices.getUserMedia(constraints) .then((stream) => { const settings = stream.getVideoTracks()[0].getSettings(); const actualw = settings.width; const actualh = settings.height; const actualfps = settings.frameRate; console.log("Camera is opened! Actual spec: (" + actualw + "x" + actualh + "), fps=" + actualfps); if (outcome(device, 1, actualw, actualh, actualfps)) { const video = document.createElement("video"); video.width = actualw; video.height = actualh; video.style.display = 'none'; video.srcObject = stream; const canvas = document.createElement("canvas"); canvas.width = actualw; canvas.height = actualh; canvas.style.display = 'none'; const ctx2d = canvas.getContext('2d'); const SDL3 = Module['SDL3']; SDL3.camera.width = actualw; SDL3.camera.height = actualh; SDL3.camera.fps = actualfps; SDL3.camera.fpsincrms = 1000.0 / actualfps; SDL3.camera.stream = stream; SDL3.camera.video = video; SDL3.camera.canvas = canvas; SDL3.camera.ctx2d = ctx2d; SDL3.camera.next_frame_time = performance.now(); video.play(); video.addEventListener('loadedmetadata', () => { grabNextCameraFrame(); }); } }) .catch((err) => { console.error("Tried to open camera but it threw an error! " + err.name + ": " + err.message); outcome(device, 0, 0, 0, 0); }); },  
 17393963: () => { const SDL3 = Module['SDL3']; if ((typeof(SDL3) === 'undefined') || (typeof(SDL3.camera) === 'undefined') || (typeof(SDL3.camera.stream) === 'undefined')) { return; } SDL3.camera.stream.getTracks().forEach(track => track.stop()); SDL3.camera = {}; },  
 17394214: ($0, $1, $2) => { const w = $0; const h = $1; const rgba = $2; const SDL3 = Module['SDL3']; if ((typeof(SDL3) === 'undefined') || (typeof(SDL3.camera) === 'undefined') || (typeof(SDL3.camera.ctx2d) === 'undefined')) { return 0; } SDL3.camera.ctx2d.drawImage(SDL3.camera.video, 0, 0, w, h); const imgrgba = SDL3.camera.ctx2d.getImageData(0, 0, w, h).data; HEAPU8.set(imgrgba, rgba); return 1; },  
 17394592: () => { if (typeof(Module['SDL3']) !== 'undefined') { Module['SDL3'].camera = undefined; } },  
 17394679: ($0) => { let gamepads = navigator['getGamepads'](); if (!gamepads) { return 0; } let gamepad = gamepads[$0]; if (!gamepad || !gamepad['vibrationActuator']) { return 0; } return 1; },  
 17394854: ($0, $1, $2) => { let gamepads = navigator['getGamepads'](); if (!gamepads) { return 0; } let gamepad = gamepads[$0]; if (!gamepad || !gamepad['vibrationActuator']) { return 0; } gamepad['vibrationActuator']['playEffect']('dual-rumble', { 'startDelay': 0, 'duration': 3000, 'weakMagnitude': $2 / 0xFFFF, 'strongMagnitude': $1 / 0xFFFF, }); return 1; },  
 17395190: ($0, $1) => { var buf = $0; var buflen = $1; var list = undefined; if (navigator.languages && navigator.languages.length) { list = navigator.languages; } else { var oneOfThese = navigator.userLanguage || navigator.language || navigator.browserLanguage || navigator.systemLanguage; if (oneOfThese !== undefined) { list = [ oneOfThese ]; } } if (list === undefined) { return; } var str = ""; for (var i = 0; i < list.length; i++) { var item = list[i]; if ((str.length + item.length + 1) > buflen) { break; } if (str.length > 0) { str += ","; } str += item; } str = str.replace(/-/g, "_"); if (buflen > str.length) { buflen = str.length; } for (var i = 0; i < buflen; i++) { setValue(buf + i, str.charCodeAt(i), "i8"); } },  
 17395898: ($0) => { var data = $0; document.sdlEventHandlerLockKeysCheck = function(event) { if ((event.key != "CapsLock") && (event.key != "NumLock") && (event.key != "ScrollLock")) { _SDL3_renamed_Emscripten_HandleLockKeysCheck(Module['SDL3'].JSVarToCPtr(data), event.getModifierState("CapsLock"), event.getModifierState("NumLock"), event.getModifierState("ScrollLock")); } }; document.addEventListener("keydown", document.sdlEventHandlerLockKeysCheck); },  
 17396338: () => { document.removeEventListener("keydown", document.sdlEventHandlerLockKeysCheck); },  
 17396422: ($0) => { var target = document; if (target) { target.sdlEventHandlerMouseButtonUpGlobal = function(event) { var SDL3 = Module['SDL3']; var d = SDL3.makePointerEventCStruct(0, 0, event); if (d != 0) { _SDL3_renamed_Emscripten_HandleMouseButtonUpGlobal(SDL3.JSVarToCPtr($0), d); _SDL3_renamed_SDL_free(d); } }; target.addEventListener("pointerup", target.sdlEventHandlerMouseButtonUpGlobal); } },  
 17396809: ($0) => { var SDL3 = Module['SDL3']; if (SDL3.makePointerEventCStruct === undefined) { SDL3.makePointerEventCStruct = function(left, top, event) { var ptrtype = 0; if (event.pointerType == "mouse") { ptrtype = 1; } else if (event.pointerType == "touch") { ptrtype = 2; } else if (event.pointerType == "pen") { ptrtype = 3; } else { return 0; } var ptr = _SDL3_renamed_SDL_malloc($0); if (ptr != 0) { var idx = SDL3.CPtrToHeap32Index(ptr); HEAP32[idx++] = ptrtype; HEAP32[idx++] = event.pointerId; HEAP32[idx++] = (typeof(event.button) !== "undefined") ? event.button : -1; HEAP32[idx++] = event.buttons; HEAP32[idx++] = (event.type == "pointerdown") ? 1 : 0; HEAPF32[idx++] = event.movementX; HEAPF32[idx++] = event.movementY; HEAPF32[idx++] = event.clientX - left; HEAPF32[idx++] = event.clientY - top; if (ptrtype == 3) { HEAPF32[idx++] = event.pressure; HEAPF32[idx++] = event.tangentialPressure; HEAPF32[idx++] = event.tiltX; HEAPF32[idx++] = event.tiltY; HEAPF32[idx++] = event.twist; } } return ptr; }; } },  
 17397814: ($0) => { var id = UTF8ToString($0); try { var canvas = document.querySelector(id); if (canvas) { return canvas === document.activeElement; } } catch (e) { } return false; },  
 17397980: () => { return document.hasFocus(); },  
 17398012: () => { var target = document; if (target) { target.removeEventListener("pointerup", target.sdlEventHandlerMouseButtonUpGlobal); target.sdlEventHandlerMouseButtonUpGlobal = undefined; } },  
 17398194: () => { return document.body.clientWidth; },  
 17398232: () => { return document.body.clientHeight; },  
 17398271: () => { return window.innerWidth; },  
 17398301: () => { return window.innerHeight; },  
 17398332: () => { return window.outerWidth; },  
 17398362: () => { return window.outerHeight; },  
 17398393: () => { return window.pageXOffset; },  
 17398424: () => { return window.pageYOffset; },  
 17398455: ($0, $1) => { var target = document.querySelector(UTF8ToString($1)); if (target) { var SDL3 = Module['SDL3']; var data = $0; target.sdlEventHandlerPointerEnter = function(event) { var rect = target.getBoundingClientRect(); var d = SDL3.makePointerEventCStruct(rect.left, rect.top, event); if (d != 0) { _SDL3_renamed_Emscripten_HandlePointerEnter(SDL3.JSVarToCPtr(data), d); _SDL3_renamed_SDL_free(d); } }; target.sdlEventHandlerPointerLeave = function(event) { var rect = target.getBoundingClientRect(); var d = SDL3.makePointerEventCStruct(rect.left, rect.top, event); if (d != 0) { _SDL3_renamed_Emscripten_HandlePointerLeave(SDL3.JSVarToCPtr(data), d); _SDL3_renamed_SDL_free(d); } }; target.sdlEventHandlerPointerGeneric = function(event) { var rect = target.getBoundingClientRect(); var d = SDL3.makePointerEventCStruct(rect.left, rect.top, event); if (d != 0) { _SDL3_renamed_Emscripten_HandlePointerGeneric(SDL3.JSVarToCPtr(data), d); _SDL3_renamed_SDL_free(d); } }; target.style.touchAction = "none"; target.addEventListener("pointerenter", target.sdlEventHandlerPointerEnter); target.addEventListener("pointerleave", target.sdlEventHandlerPointerLeave); target.addEventListener("pointercancel", target.sdlEventHandlerPointerLeave); target.addEventListener("pointerdown", target.sdlEventHandlerPointerGeneric); target.addEventListener("pointermove", target.sdlEventHandlerPointerGeneric); target.addEventListener("pointerup", target.sdlEventHandlerPointerGeneric); } },  
 17399921: ($0, $1, $2) => { var target = document.querySelector(UTF8ToString($1)); if (target) { var data = $0; var SDL3 = Module['SDL3']; var makeDropEventCStruct = function(event) { var ptr = 0; ptr = _SDL3_renamed_SDL_malloc($2); if (ptr != 0) { var idx = ptr >> 2; var rect = target.getBoundingClientRect(); HEAP32[idx++] = event.clientX - rect.left; HEAP32[idx++] = event.clientY - rect.top; } return ptr; }; SDL3.eventHandlerDropDragover = function(event) { event.preventDefault(); var d = makeDropEventCStruct(event); if (d != 0) { _SDL3_renamed_Emscripten_SendDragEvent(data, d); _SDL3_renamed_SDL_free(d); } }; target.addEventListener("dragover", SDL3.eventHandlerDropDragover); SDL3.drop_count = 0; try { FS.mkdir("/tmp/filedrop"); } catch (e) {} SDL3.eventHandlerDropDrop = function(event) { event.preventDefault(); if (event.dataTransfer.types.includes("text/plain")) { let plain_text = stringToNewUTF8(event.dataTransfer.getData("text/plain")); _SDL3_renamed_Emscripten_SendDragTextEvent(data, plain_text); _SDL3_renamed_Emscripten_force_free(plain_text); } else if (event.dataTransfer.types.includes("Files")) { let files_read = 0; const files_to_read = event.dataTransfer.files.length; for (let i = 0; i < files_to_read; i++) { const file = event.dataTransfer.files.item(i); const file_reader = new FileReader(); file_reader.readAsArrayBuffer(file); file_reader.onload = function(event) { const fs_dropdir = `/tmp/filedrop/${SDL3.drop_count}`; SDL3.drop_count += 1; const fs_filepath = `${fs_dropdir}/${file.name}`; const c_fs_filepath = stringToNewUTF8(fs_filepath); const contents_array8 = new Uint8Array(event.target.result); try { FS.mkdir(fs_dropdir); var stream = FS.open(fs_filepath, "w"); FS.write(stream, contents_array8, 0, contents_array8.length, 0); FS.close(stream); _SDL3_renamed_Emscripten_SendDragFileEvent(data, c_fs_filepath); } catch (e) { } _SDL3_renamed_Emscripten_force_free(c_fs_filepath); onFileRead(); }; file_reader.onerror = function(event) { onFileRead(); }; } function onFileRead() { ++files_read; if (files_read === files_to_read) { _SDL3_renamed_Emscripten_SendDragCompleteEvent(data); } } } _SDL3_renamed_Emscripten_SendDragCompleteEvent(data); }; target.addEventListener("drop", SDL3.eventHandlerDropDrop); SDL3.eventHandlerDropDragend = function(event) { event.preventDefault(); _SDL3_renamed_Emscripten_SendDragCompleteEvent(data); }; target.addEventListener("dragend", SDL3.eventHandlerDropDragend); target.addEventListener("dragleave", SDL3.eventHandlerDropDragend); } },  
 17402418: ($0) => { var target = document.querySelector(UTF8ToString($0)); if (target) { var SDL3 = Module['SDL3']; target.removeEventListener("dragleave", SDL3.eventHandlerDropDragend); target.removeEventListener("dragend", SDL3.eventHandlerDropDragend); target.removeEventListener("drop", SDL3.eventHandlerDropDrop); SDL3.drop_count = undefined; function recursive_remove(dirpath) { FS.readdir(dirpath).forEach((filename) => { const p = `${dirpath}/${filename}`; const p_s = FS.stat(p); if (FS.isFile(p_s.mode)) { FS.unlink(p); } else if (FS.isDir(p)) { recursive_remove(p); } }); FS.rmdir(dirpath); }("/tmp/filedrop"); FS.rmdir("/tmp/filedrop"); target.removeEventListener("dragover", SDL3.eventHandlerDropDragover); SDL3.eventHandlerDropDragover = undefined; SDL3.eventHandlerDropDrop = undefined; SDL3.eventHandlerDropDragend = undefined; } },  
 17403248: ($0) => { var target = document.querySelector(UTF8ToString($0)); if (target) { target.removeEventListener("pointerenter", target.sdlEventHandlerPointerEnter); target.removeEventListener("pointerleave", target.sdlEventHandlerPointerLeave); target.removeEventListener("pointercancel", target.sdlEventHandlerPointerLeave); target.removeEventListener("pointerdown", target.sdlEventHandlerPointerGeneric); target.removeEventListener("pointermove", target.sdlEventHandlerPointerGeneric); target.removeEventListener("pointerup", target.sdlEventHandlerPointerGeneric); target.style.touchAction = ""; target.sdlEventHandlerPointerEnter = undefined; target.sdlEventHandlerPointerLeave = undefined; target.sdlEventHandlerPointerGeneric = undefined; } },  
 17403982: ($0, $1, $2, $3) => { var w = $0; var h = $1; var pixels = $2; var canvasId = UTF8ToString($3); var canvas = document.querySelector(canvasId); var SDL3 = Module['SDL3']; if (SDL3.ctxCanvas !== canvas) { SDL3.ctx = Browser.createContext(canvas, false, true); if (!SDL3.ctx) { return false; } SDL3.ctxCanvas = canvas; } if (SDL3.w !== w || SDL3.h !== h || SDL3.imageCtx !== SDL3.ctx) { SDL3.image = SDL3.ctx.createImageData(w, h); SDL3.w = w; SDL3.h = h; SDL3.imageCtx = SDL3.ctx; } var data = SDL3.image.data; var src = pixels / 4; if (SDL3.data32Data !== data) { SDL3.data32 = new Int32Array(data.buffer); SDL3.data32Data = data; } var data32 = SDL3.data32; data32.set(HEAP32.subarray(src, src + data32.length)); SDL3.ctx.putImageData(SDL3.image, 0, 0); return true; },  
 17404731: () => { var SDL3 = Module['SDL3']; SDL3['mouse_x'] = 0; SDL3['mouse_y'] = 0; SDL3['mouse_buttons'] = []; for (var i = 0; i < 5; ++i) { SDL3['mouse_buttons'][i] = false; } document.addEventListener('mousemove', function(e) { var SDL3 = Module['SDL3']; SDL3['mouse_x'] = e.clientX; SDL3['mouse_y'] = e.clientY; }); document.addEventListener('mousedown', function(e) { var SDL3 = Module['SDL3']; if (0 <= e.button && e.button < SDL3['mouse_buttons'].length) { SDL3['mouse_buttons'][e.button] = true; } }); document.addEventListener('mouseup', function(e) { var SDL3 = Module['SDL3']; if (0 <= e.button && e.button < SDL3['mouse_buttons'].length) { SDL3['mouse_buttons'][e.button] = false; } }); },  
 17405419: ($0, $1, $2, $3, $4) => { var w = $0; var h = $1; var hot_x = $2; var hot_y = $3; var pixels = $4; var canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h; var ctx = canvas.getContext("2d"); var image = ctx.createImageData(w, h); var data = image.data; var src = pixels / 4; var data32 = new Int32Array(data.buffer); data32.set(HEAP32.subarray(src, src + data32.length)); ctx.putImageData(image, 0, 0); var url = hot_x === 0 && hot_y === 0 ? "url(" + canvas.toDataURL() + "), auto" : "url(" + canvas.toDataURL() + ") " + hot_x + " " + hot_y + ", auto"; var urlBuf = _SDL3_renamed_SDL_malloc(url.length + 1); stringToUTF8(url, urlBuf, url.length + 1); return urlBuf; },  
 17406090: ($0) => { if (Module['canvas']) { Module['canvas'].style['cursor'] = UTF8ToString($0); } },  
 17406173: () => { if (Module['canvas']) { Module['canvas'].style['cursor'] = 'none'; } },  
 17406242: () => { return Module['SDL3']['mouse_x']; },  
 17406280: () => { return Module['SDL3']['mouse_y']; },  
 17406318: ($0) => { return Module['SDL3']['mouse_buttons'][$0]; },  
 17406366: () => { if (!window.matchMedia) { return -1; } if (window.matchMedia('(prefers-color-scheme: light)').matches) { return 0; } if (window.matchMedia('(prefers-color-scheme: dark)').matches) { return 1; } return -1; },  
 17406575: () => { if (typeof(Module['SDL3']) != 'undefined') { var SDL3 = Module['SDL3']; SDL3.themeChangedMatchMedia.removeEventListener('change', SDL3.eventHandlerThemeChanged); SDL3.themeChangedMatchMedia = undefined; SDL3.eventHandlerThemeChanged = undefined; } },  
 17406827: () => { return window.innerWidth; },  
 17406857: () => { return window.innerHeight; },  
 17406888: ($0) => { Module['requestFullscreen'] = function(lockPointer, resizeCanvas) { _SDL3_renamed_requestFullscreenThroughSDL($0); }; },  
 17407010: ($0, $1) => { var pngData = HEAPU8.buffer instanceof ArrayBuffer ? HEAPU8.subarray($0, $0 + $1) : HEAPU8.slice($0, $0 + $1); var blob = new Blob([pngData], {type: 'image/png'}); var url = URL.createObjectURL(blob); var link = document.querySelector("link[rel~='icon']"); if (!link) { link = document.createElement('link'); link.rel = 'icon'; link.type = 'image/png'; document.head.appendChild(link); } if (link.href && link.href.startsWith('blob:')) { URL.revokeObjectURL(link.href); } link.href = url; },  
 17407503: () => { Module['requestFullscreen'] = function(lockPointer, resizeCanvas){}; },  
 17407576: () => { return window.innerWidth; },  
 17407606: () => { return window.innerHeight; },  
 17407637: ($0) => { var canvas = document.querySelector(UTF8ToString($0)); canvas.SDL3_original_position = canvas.style.position; canvas.SDL3_original_top = canvas.style.top; canvas.SDL3_original_left = canvas.style.left; var div = document.createElement('div'); div.id = 'SDL3_fill_document_background_elements'; div.SDL3_canvas = canvas; div.SDL3_canvas_parent = canvas.parentNode; div.SDL3_canvas_nextsib = canvas.nextSibling; var children = Array.from(document.body.children); for (var child of children) { div.appendChild(child); } document.body.appendChild(div); div.style.display = 'none'; document.body.appendChild(canvas); canvas.style.position = 'fixed'; canvas.style.top = '0'; canvas.style.left = '0'; },  
 17408335: () => { var div = document.getElementById('SDL3_fill_document_background_elements'); if (div) { if (div.SDL3_canvas_nextsib) { div.SDL3_canvas_parent.insertBefore(div.SDL3_canvas, div.SDL3_canvas_nextsib); } else { div.SDL3_canvas_parent.appendChild(div.SDL3_canvas); } while (div.firstChild) { document.body.insertBefore(div.firstChild, div); } div.SDL3_canvas.style.position = div.SDL3_canvas.SDL3_original_position; div.SDL3_canvas.style.top = div.SDL3_canvas.SDL3_original_top; div.SDL3_canvas.style.left = div.SDL3_canvas.SDL3_original_left; div.remove(); } },  
 17408894: () => { if (window.matchMedia) { var SDL3 = Module['SDL3']; SDL3.eventHandlerThemeChanged = function(event) { _SDL3_renamed_Emscripten_SendSystemThemeChangedEvent(); }; SDL3.themeChangedMatchMedia = window.matchMedia('(prefers-color-scheme: dark)'); SDL3.themeChangedMatchMedia.addEventListener('change', SDL3.eventHandlerThemeChanged); } },  
 17409229: ($0, $1, $2, $3, $4) => { var title = UTF8ToString($0); var message = UTF8ToString($1); var background = UTF8ToString($2); var color = UTF8ToString($3); var id = UTF8ToString($4); var dialog = document.createElement("dialog"); dialog.classList.add("SDL3_messagebox"); dialog.id = id; dialog.style.color = color; dialog.style.backgroundColor = background; document.body.append(dialog); var h1 = document.createElement("h1"); h1.innerText = title; dialog.append(h1); var p = document.createElement("p"); p.innerText = message; dialog.append(p); dialog.showModal(); },  
 17409770: ($0, $1, $2, $3, $4, $5, $6, $7) => { var dialog_id = UTF8ToString($0); var text = UTF8ToString($1); var responseId = $2; var clickOnReturn = $3; var clickOnEscape = $4; var border = UTF8ToString($5); var background = UTF8ToString($6); var hovered = UTF8ToString($7); var dialog = document.getElementById(dialog_id); if (!dialog) { return false; } var button = document.createElement("button"); button.innerText = text; button.style.borderColor = border; button.style.backgroundColor = background; dialog.addEventListener('keydown', function(e) { if (clickOnReturn && e.key === "Enter") { e.preventDefault(); button.click(); } else if (clickOnEscape && e.key === "Escape") { e.preventDefault(); button.click(); } }); dialog.addEventListener('cancel', function(e){ e.preventDefault(); }); button.onmouseenter = function(e){ button.style.backgroundColor = hovered; }; button.onmouseleave = function(e){ button.style.backgroundColor = background; }; button.onclick = function(e) { dialog.close(responseId); }; dialog.append(button); return true; },  
 17410779: ($0) => { var dialog_id = UTF8ToString($0); var dialog = document.getElementById(dialog_id); if (!dialog) { return false; } return dialog.open; },  
 17410917: ($0) => { var dialog_id = UTF8ToString($0); var dialog = document.getElementById(dialog_id); if (!dialog) { return 0; } try { return parseInt(dialog.returnValue); } catch(e) { return 0; } },  
 17411099: ($0, $1) => { alert(UTF8ToString($0) + "\n\n" + UTF8ToString($1)); }
};
function SDL3_renamed_SDL_GetEmscriptenJoystickVendor(device_index) { let gamepad = navigator['getGamepads']()[device_index]; let vendor_str = 'Vendor: '; if (gamepad['id']['indexOf'](vendor_str) > 0) { let vendor_str_index = gamepad['id']['indexOf'](vendor_str) + vendor_str['length']; return parseInt(gamepad['id']['substr'](vendor_str_index, 4), 16); } let id_split = gamepad['id']['split']('-'); if (id_split['length'] > 1 && !isNaN(parseInt(id_split[0], 16))) { return parseInt(id_split[0], 16); } return 0; }
function SDL3_renamed_SDL_GetEmscriptenJoystickProduct(device_index) { let gamepad = navigator['getGamepads']()[device_index]; let product_str = 'Product: '; if (gamepad['id']['indexOf'](product_str) > 0) { let product_str_index = gamepad['id']['indexOf'](product_str) + product_str['length']; return parseInt(gamepad['id']['substr'](product_str_index, 4), 16); } let id_split = gamepad['id']['split']('-'); if (id_split['length'] > 1 && !isNaN(parseInt(id_split[1], 16))) { return parseInt(id_split[1], 16); } return 0; }
function SDL3_renamed_SDL_IsEmscriptenJoystickXInput(device_index) { let gamepad = navigator['getGamepads']()[device_index]; return gamepad['id']['toLowerCase']()['indexOf']('xinput') >= 0; }



  /** @constructor */
  function ExitStatus(status) {
      this.name = 'ExitStatus';
      this.message = `Program terminated with exit(${status})`;
      this.status = status;
    }

  
  
  var terminateWorker = (worker) => {
      worker.terminate();
      // terminate() can be asynchronous, so in theory the worker can continue
      // to run for some amount of time after termination.  However from our POV
      // the worker now dead and we don't want to hear from it again, so we stub
      // out its message handler here.  This avoids having to check in each of
      // the onmessage handlers if the message was coming from valid worker.
      worker.onmessage = (e) => {
      };
    };
  
  var killThread = (pthread_ptr) => {
      var worker = PThread.pthreads[pthread_ptr];
      delete PThread.pthreads[pthread_ptr];
      terminateWorker(worker);
      __emscripten_thread_free_data(pthread_ptr);
      // The worker was completely nuked (not just the pthread execution it was hosting), so remove it from running workers
      // but don't put it back to the pool.
      PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(worker), 1); // Not a running Worker anymore.
      worker.pthread_ptr = 0;
    };
  
  var cancelThread = (pthread_ptr) => {
      var worker = PThread.pthreads[pthread_ptr];
      worker.postMessage({ 'cmd': 'cancel' });
    };
  
  var cleanupThread = (pthread_ptr) => {
      var worker = PThread.pthreads[pthread_ptr];
      PThread.returnWorkerToPool(worker);
    };
  
  var zeroMemory = (address, size) => {
      HEAPU8.fill(0, address, address + size);
      return address;
    };
  
  var spawnThread = (threadParams) => {
  
      var worker = PThread.getNewWorker();
      if (!worker) {
        // No available workers in the PThread pool.
        return 6;
      }
  
      PThread.runningWorkers.push(worker);
  
      // Add to pthreads map
      PThread.pthreads[threadParams.pthread_ptr] = worker;
  
      worker.pthread_ptr = threadParams.pthread_ptr;
      var msg = {
          'cmd': 'run',
          'start_routine': threadParams.startRoutine,
          'arg': threadParams.arg,
          'pthread_ptr': threadParams.pthread_ptr,
      };
      // Note that we do not need to quote these names because they are only used
      // in this file, and not from the external worker.js.
      msg.moduleCanvasId = threadParams.moduleCanvasId;
      msg.offscreenCanvases = threadParams.offscreenCanvases;
      if (ENVIRONMENT_IS_NODE) {
        // Mark worker as weakly referenced once we start executing a pthread,
        // so that its existence does not prevent Node.js from exiting.  This
        // has no effect if the worker is already weakly referenced (e.g. if
        // this worker was previously idle/unused).
        worker.unref();
      }
      // Ask the worker to start executing its pthread entry point function.
      worker.postMessage(msg, threadParams.transferList);
      return 0;
    };
  
  
  
  var runtimeKeepaliveCounter = 0;
  var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;
  
  
  var withStackSave = (f) => {
      var stack = stackSave();
      var ret = f();
      stackRestore(stack);
      return ret;
    };
  
  
  var MAX_INT53 = 9007199254740992;
  
  var MIN_INT53 = -9007199254740992;
  var bigintToI53Checked = (num) => (num < MIN_INT53 || num > MAX_INT53) ? NaN : Number(num);
  
  /** @type{function(number, (number|boolean), ...number)} */
  var proxyToMainThread = (funcIndex, emAsmAddr, sync, ...callArgs) => {
      // EM_ASM proxying is done by passing a pointer to the address of the EM_ASM
      // content as `emAsmAddr`.  JS library proxying is done by passing an index
      // into `proxiedJSCallArgs` as `funcIndex`. If `emAsmAddr` is non-zero then
      // `funcIndex` will be ignored.
      // Additional arguments are passed after the first three are the actual
      // function arguments.
      // The serialization buffer contains the number of call params, and then
      // all the args here.
      // We also pass 'sync' to C separately, since C needs to look at it.
      // Allocate a buffer, which will be copied by the C code.
      return withStackSave(() => {
        // First passed parameter specifies the number of arguments to the function.
        // When BigInt support is enabled, we must handle types in a more complex
        // way, detecting at runtime if a value is a BigInt or not (as we have no
        // type info here). To do that, add a "prefix" before each value that
        // indicates if it is a BigInt, which effectively doubles the number of
        // values we serialize for proxying. TODO: pack this?
        var serializedNumCallArgs = callArgs.length * 2;
        var args = stackAlloc(serializedNumCallArgs * 8);
        var b = ((args)>>3);
        for (var i = 0; i < callArgs.length; i++) {
          var arg = callArgs[i];
          if (typeof arg == 'bigint') {
            // The prefix is non-zero to indicate a bigint.
            HEAP64[b + 2*i] = 1n;
            HEAP64[b + 2*i + 1] = arg;
          } else {
            // The prefix is zero to indicate a JS Number.
            HEAP64[b + 2*i] = 0n;
            HEAPF64[b + 2*i + 1] = arg;
          }
        }
        return __emscripten_run_on_main_thread_js(funcIndex, emAsmAddr, serializedNumCallArgs, args, sync);
      });
    };
  
  function _proc_exit(code) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(0, 0, 1, code);
  
      EXITSTATUS = code;
      if (!keepRuntimeAlive()) {
        PThread.terminateAllThreads();
        Module['onExit']?.(code);
        ABORT = true;
      }
      quit_(code, new ExitStatus(code));
    
  }
  
  
  /** @suppress {duplicate } */
  /** @param {boolean|number=} implicit */
  var exitJS = (status, implicit) => {
      EXITSTATUS = status;
  
      if (ENVIRONMENT_IS_PTHREAD) {
        // implicit exit can never happen on a pthread
        // When running in a pthread we propagate the exit back to the main thread
        // where it can decide if the whole process should be shut down or not.
        // The pthread may have decided not to exit its own runtime, for example
        // because it runs a main loop, but that doesn't affect the main thread.
        exitOnMainThread(status);
        throw 'unwind';
      }
  
      if (!keepRuntimeAlive()) {
        exitRuntime();
      }
  
      _proc_exit(status);
    };
  var _exit = exitJS;
  
  var handleException = (e) => {
      // Certain exception types we do not treat as errors since they are used for
      // internal control flow.
      // 1. ExitStatus, which is thrown by exit()
      // 2. "unwind", which is thrown by emscripten_unwind_to_js_event_loop() and others
      //    that wish to return to JS event loop.
      if (e instanceof ExitStatus || e == 'unwind') {
        return EXITSTATUS;
      }
      quit_(1, e);
    };
  
  var PThread = {
  unusedWorkers:[],
  runningWorkers:[],
  tlsInitFunctions:[],
  pthreads:{
  },
  init() {
        if (ENVIRONMENT_IS_PTHREAD
          ) {
          PThread.initWorker();
        } else {
          PThread.initMainThread();
        }
      },
  initMainThread() {
        // MINIMAL_RUNTIME takes care of calling loadWasmModuleToAllWorkers
        // in postamble_minimal.js
        addOnPreRun(() => {
          addRunDependency('loading-workers')
          PThread.loadWasmModuleToAllWorkers(() => removeRunDependency('loading-workers'));
        });
      },
  initWorker() {
        // worker.js is not compiled together with us, and must access certain
        // things.
        PThread['receiveObjectTransfer'] = PThread.receiveObjectTransfer;
        PThread['threadInitTLS'] = PThread.threadInitTLS;
        PThread['setExitStatus'] = PThread.setExitStatus;
  
        // The default behaviour for pthreads is always to exit once they return
        // from their entry point (or call pthread_exit).  If we set noExitRuntime
        // to true here on pthreads they would never complete and attempt to
        // pthread_join to them would block forever.
        // pthreads can still choose to set `noExitRuntime` explicitly, or
        // call emscripten_unwind_to_js_event_loop to extend their lifetime beyond
        // their main function.  See comment in src/worker.js for more.
        noExitRuntime = false;
      },
  setExitStatus:(status) => EXITSTATUS = status,
  terminateAllThreads__deps:["$terminateWorker"],
  terminateAllThreads:() => {
        // Attempt to kill all workers.  Sadly (at least on the web) there is no
        // way to terminate a worker synchronously, or to be notified when a
        // worker in actually terminated.  This means there is some risk that
        // pthreads will continue to be executing after `worker.terminate` has
        // returned.  For this reason, we don't call `returnWorkerToPool` here or
        // free the underlying pthread data structures.
        for (var worker of PThread.runningWorkers) {
          terminateWorker(worker);
        }
        for (var worker of PThread.unusedWorkers) {
          terminateWorker(worker);
        }
        PThread.unusedWorkers = [];
        PThread.runningWorkers = [];
        PThread.pthreads = [];
      },
  returnWorkerToPool:(worker) => {
        // We don't want to run main thread queued calls here, since we are doing
        // some operations that leave the worker queue in an invalid state until
        // we are completely done (it would be bad if free() ends up calling a
        // queued pthread_create which looks at the global data structures we are
        // modifying). To achieve that, defer the free() til the very end, when
        // we are all done.
        var pthread_ptr = worker.pthread_ptr;
        delete PThread.pthreads[pthread_ptr];
        // Note: worker is intentionally not terminated so the pool can
        // dynamically grow.
        PThread.unusedWorkers.push(worker);
        PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(worker), 1);
        // Not a running Worker anymore
        // Detach the worker from the pthread object, and return it to the
        // worker pool as an unused worker.
        worker.pthread_ptr = 0;
  
        // Finally, free the underlying (and now-unused) pthread structure in
        // linear memory.
        __emscripten_thread_free_data(pthread_ptr);
      },
  receiveObjectTransfer(data) {
        if (typeof GL != 'undefined') {
          Object.assign(GL.offscreenCanvases, data.offscreenCanvases);
          if (!Module['canvas'] && data.moduleCanvasId && GL.offscreenCanvases[data.moduleCanvasId]) {
            Module['canvas'] = GL.offscreenCanvases[data.moduleCanvasId].offscreenCanvas;
            Module['canvas'].id = data.moduleCanvasId;
          }
        }
      },
  threadInitTLS() {
        // Call thread init functions (these are the _emscripten_tls_init for each
        // module loaded.
        PThread.tlsInitFunctions.forEach((f) => f());
      },
  loadWasmModuleToWorker:(worker) => new Promise((onFinishedLoading) => {
        worker.onmessage = (e) => {
          var d = e['data'];
          var cmd = d['cmd'];
  
          // If this message is intended to a recipient that is not the main
          // thread, forward it to the target thread.
          if (d['targetThread'] && d['targetThread'] != _pthread_self()) {
            var targetWorker = PThread.pthreads[d['targetThread']];
            if (targetWorker) {
              targetWorker.postMessage(d, d['transferList']);
            } else {
              err(`Internal error! Worker sent a message "${cmd}" to target pthread ${d['targetThread']}, but that thread no longer exists!`);
            }
            return;
          }
  
          if (cmd === 'checkMailbox') {
            checkMailbox();
          } else if (cmd === 'spawnThread') {
            spawnThread(d);
          } else if (cmd === 'cleanupThread') {
            cleanupThread(d['thread']);
          } else if (cmd === 'killThread') {
            killThread(d['thread']);
          } else if (cmd === 'cancelThread') {
            cancelThread(d['thread']);
          } else if (cmd === 'loaded') {
            worker.loaded = true;
            onFinishedLoading(worker);
          } else if (cmd === 'alert') {
            alert(`Thread ${d['threadId']}: ${d['text']}`);
          } else if (d.target === 'setimmediate') {
            // Worker wants to postMessage() to itself to implement setImmediate()
            // emulation.
            worker.postMessage(d);
          } else if (cmd === 'callHandler') {
            Module[d['handler']](...d['args']);
          } else if (cmd) {
            // The received message looks like something that should be handled by this message
            // handler, (since there is a e.data.cmd field present), but is not one of the
            // recognized commands:
            err(`worker sent an unknown command ${cmd}`);
          }
        };
  
        worker.onerror = (e) => {
          var message = 'worker sent an error!';
          err(`${message} ${e.filename}:${e.lineno}: ${e.message}`);
          throw e;
        };
  
        if (ENVIRONMENT_IS_NODE) {
          worker.on('message', (data) => worker.onmessage({ data: data }));
          worker.on('error', (e) => worker.onerror(e));
        }
  
        // When running on a pthread, none of the incoming parameters on the module
        // object are present. Proxy known handlers back to the main thread if specified.
        var handlers = [];
        var knownHandlers = [
          'onExit',
          'onAbort',
          'print',
          'printErr',
        ];
        for (var handler of knownHandlers) {
          if (Module.hasOwnProperty(handler)) {
            handlers.push(handler);
          }
        }
  
        // Ask the new worker to load up the Emscripten-compiled page. This is a heavy operation.
        worker.postMessage({
          'cmd': 'load',
          'handlers': handlers,
          // If the application main .js file was loaded from a Blob, then it is not possible
          // to access the URL of the current script that could be passed to a Web Worker so that
          // it could load up the same file. In that case, developer must either deliver the Blob
          // object in Module['mainScriptUrlOrBlob'], or a URL to it, so that pthread Workers can
          // independently load up the same main application file.
          'urlOrBlob': Module['mainScriptUrlOrBlob']
          ,
          'wasmMemory': wasmMemory,
          'wasmModule': wasmModule,
        });
      }),
  loadWasmModuleToAllWorkers(onMaybeReady) {
        onMaybeReady();
      },
  allocateUnusedWorker() {
        var worker;
        // If we're using module output and there's no explicit override, use bundler-friendly pattern.
        if (!Module['locateFile']) {
          worker = new Worker(new URL('dotnet.native.worker.mjs', import.meta.url), {type: 'module'});
        } else {
        // Allow HTML module to configure the location where the 'worker.js' file will be loaded from,
        // via Module.locateFile() function. If not specified, then the default URL 'worker.js' relative
        // to the main html file is loaded.
        var pthreadMainJs = locateFile('dotnet.native.worker.mjs');
        worker = new Worker(pthreadMainJs, {type: 'module'});
      }
      PThread.unusedWorkers.push(worker);
      },
  getNewWorker() {
        if (PThread.unusedWorkers.length == 0) {
  // PTHREAD_POOL_SIZE_STRICT should show a warning and, if set to level `2`, return from the function.
          PThread.allocateUnusedWorker();
          PThread.loadWasmModuleToWorker(PThread.unusedWorkers[0]);
        }
        return PThread.unusedWorkers.pop();
      },
  };
  Module['PThread'] = PThread;

  var callRuntimeCallbacks = (callbacks) => {
      while (callbacks.length > 0) {
        // Pass the module as the first argument.
        callbacks.shift()(Module);
      }
    };

  
  var establishStackSpace = () => {
      var pthread_ptr = _pthread_self();
      var stackHigh = HEAPU32[(((pthread_ptr)+(52))>>2)];
      var stackSize = HEAPU32[(((pthread_ptr)+(56))>>2)];
      var stackLow = stackHigh - stackSize;
      // Set stack limits used by `emscripten/stack.h` function.  These limits are
      // cached in wasm-side globals to make checks as fast as possible.
      _emscripten_stack_set_limits(stackHigh, stackLow);
  
      // Call inside wasm module to set up the stack frame for this pthread in wasm module scope
      stackRestore(stackHigh);
  
    };
  Module['establishStackSpace'] = establishStackSpace;

  
  
  
  
  function exitOnMainThread(returnCode) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(1, 0, 0, returnCode);
  
      _exit(returnCode);
    
  }
  

  
    /**
     * @param {number} ptr
     * @param {string} type
     */
  function getValue(ptr, type = 'i8') {
    if (type.endsWith('*')) type = '*';
    switch (type) {
      case 'i1': return HEAP8[ptr];
      case 'i8': return HEAP8[ptr];
      case 'i16': return HEAP16[((ptr)>>1)];
      case 'i32': return HEAP32[((ptr)>>2)];
      case 'i64': return HEAP64[((ptr)>>3)];
      case 'float': return HEAPF32[((ptr)>>2)];
      case 'double': return HEAPF64[((ptr)>>3)];
      case '*': return HEAPU32[((ptr)>>2)];
      default: abort(`invalid type for getValue: ${type}`);
    }
  }

  
  
  
  
  var wasmTableMirror = [];
  
  var wasmTable;
  var getWasmTableEntry = (funcPtr) => {
      var func = wasmTableMirror[funcPtr];
      if (!func) {
        if (funcPtr >= wasmTableMirror.length) wasmTableMirror.length = funcPtr + 1;
        wasmTableMirror[funcPtr] = func = wasmTable.get(funcPtr);
      }
      return func;
    };
  var invokeEntryPoint = (ptr, arg) => {
      // An old thread on this worker may have been canceled without returning the
      // `runtimeKeepaliveCounter` to zero. Reset it now so the new thread won't
      // be affected.
      runtimeKeepaliveCounter = 0;
  
      // pthread entry points are always of signature 'void *ThreadMain(void *arg)'
      // Native codebases sometimes spawn threads with other thread entry point
      // signatures, such as void ThreadMain(void *arg), void *ThreadMain(), or
      // void ThreadMain().  That is not acceptable per C/C++ specification, but
      // x86 compiler ABI extensions enable that to work. If you find the
      // following line to crash, either change the signature to "proper" void
      // *ThreadMain(void *arg) form, or try linking with the Emscripten linker
      // flag -sEMULATE_FUNCTION_POINTER_CASTS to add in emulation for this x86
      // ABI extension.
      var result = getWasmTableEntry(ptr)(arg);
      function finish(result) {
        if (keepRuntimeAlive()) {
          PThread.setExitStatus(result);
        } else {
          __emscripten_thread_exit(result);
        }
      }
      finish(result);
    };
  Module['invokeEntryPoint'] = invokeEntryPoint;

  var noExitRuntime = Module['noExitRuntime'] || false;

  var registerTLSInit = (tlsInitFunc) => PThread.tlsInitFunctions.push(tlsInitFunc);

  
    /**
     * @param {number} ptr
     * @param {number} value
     * @param {string} type
     */
  function setValue(ptr, value, type = 'i8') {
    if (type.endsWith('*')) type = '*';
    switch (type) {
      case 'i1': HEAP8[ptr] = value; break;
      case 'i8': HEAP8[ptr] = value; break;
      case 'i16': HEAP16[((ptr)>>1)] = value; break;
      case 'i32': HEAP32[((ptr)>>2)] = value; break;
      case 'i64': HEAP64[((ptr)>>3)] = BigInt(value); break;
      case 'float': HEAPF32[((ptr)>>2)] = value; break;
      case 'double': HEAPF64[((ptr)>>3)] = value; break;
      case '*': HEAPU32[((ptr)>>2)] = value; break;
      default: abort(`invalid type for setValue: ${type}`);
    }
  }

  /** @type {function(...*):?} */
  function _SDL_AndroidBackButton(
  ) {
  abort('missing function: SDL_AndroidBackButton');
  }
  _SDL_AndroidBackButton.stub = true;

  /** @type {function(...*):?} */
  function _SDL_AndroidGetActivity(
  ) {
  abort('missing function: SDL_AndroidGetActivity');
  }
  _SDL_AndroidGetActivity.stub = true;

  /** @type {function(...*):?} */
  function _SDL_AndroidGetExternalStoragePath(
  ) {
  abort('missing function: SDL_AndroidGetExternalStoragePath');
  }
  _SDL_AndroidGetExternalStoragePath.stub = true;

  /** @type {function(...*):?} */
  function _SDL_AndroidGetExternalStorageState(
  ) {
  abort('missing function: SDL_AndroidGetExternalStorageState');
  }
  _SDL_AndroidGetExternalStorageState.stub = true;

  /** @type {function(...*):?} */
  function _SDL_AndroidGetInternalStoragePath(
  ) {
  abort('missing function: SDL_AndroidGetInternalStoragePath');
  }
  _SDL_AndroidGetInternalStoragePath.stub = true;

  /** @type {function(...*):?} */
  function _SDL_AndroidGetJNIEnv(
  ) {
  abort('missing function: SDL_AndroidGetJNIEnv');
  }
  _SDL_AndroidGetJNIEnv.stub = true;

  /** @type {function(...*):?} */
  function _SDL_AndroidRequestPermission(
  ) {
  abort('missing function: SDL_AndroidRequestPermission');
  }
  _SDL_AndroidRequestPermission.stub = true;

  /** @type {function(...*):?} */
  function _SDL_AndroidShowToast(
  ) {
  abort('missing function: SDL_AndroidShowToast');
  }
  _SDL_AndroidShowToast.stub = true;

  /** @type {function(...*):?} */
  function _SDL_CloseIO(
  ) {
  abort('missing function: SDL_CloseIO');
  }
  _SDL_CloseIO.stub = true;

  /** @type {function(...*):?} */
  function _SDL_CreateThreadRuntime(
  ) {
  abort('missing function: SDL_CreateThreadRuntime');
  }
  _SDL_CreateThreadRuntime.stub = true;

  /** @type {function(...*):?} */
  function _SDL_DestroyAudioStream(
  ) {
  abort('missing function: SDL_DestroyAudioStream');
  }
  _SDL_DestroyAudioStream.stub = true;

  /** @type {function(...*):?} */
  function _SDL_GDKRunApp(
  ) {
  abort('missing function: SDL_GDKRunApp');
  }
  _SDL_GDKRunApp.stub = true;

  /** @type {function(...*):?} */
  function _SDL_GetAndroidSDKVersion(
  ) {
  abort('missing function: SDL_GetAndroidSDKVersion');
  }
  _SDL_GetAndroidSDKVersion.stub = true;

  /** @type {function(...*):?} */
  function _SDL_GetAudioDeviceFormat(
  ) {
  abort('missing function: SDL_GetAudioDeviceFormat');
  }
  _SDL_GetAudioDeviceFormat.stub = true;

  /** @type {function(...*):?} */
  function _SDL_GetAudioPlaybackDevices(
  ) {
  abort('missing function: SDL_GetAudioPlaybackDevices');
  }
  _SDL_GetAudioPlaybackDevices.stub = true;

  /** @type {function(...*):?} */
  function _SDL_GetAudioStreamDevice(
  ) {
  abort('missing function: SDL_GetAudioStreamDevice');
  }
  _SDL_GetAudioStreamDevice.stub = true;

  /** @type {function(...*):?} */
  function _SDL_GetIOProperties(
  ) {
  abort('missing function: SDL_GetIOProperties');
  }
  _SDL_GetIOProperties.stub = true;

  /** @type {function(...*):?} */
  function _SDL_GetPointerProperty(
  ) {
  abort('missing function: SDL_GetPointerProperty');
  }
  _SDL_GetPointerProperty.stub = true;

  /** @type {function(...*):?} */
  function _SDL_IOFromFile(
  ) {
  abort('missing function: SDL_IOFromFile');
  }
  _SDL_IOFromFile.stub = true;

  /** @type {function(...*):?} */
  function _SDL_IOFromMem(
  ) {
  abort('missing function: SDL_IOFromMem');
  }
  _SDL_IOFromMem.stub = true;

  /** @type {function(...*):?} */
  function _SDL_IsAndroidTV(
  ) {
  abort('missing function: SDL_IsAndroidTV');
  }
  _SDL_IsAndroidTV.stub = true;

  /** @type {function(...*):?} */
  function _SDL_IsChromebook(
  ) {
  abort('missing function: SDL_IsChromebook');
  }
  _SDL_IsChromebook.stub = true;

  /** @type {function(...*):?} */
  function _SDL_IsDeXMode(
  ) {
  abort('missing function: SDL_IsDeXMode');
  }
  _SDL_IsDeXMode.stub = true;

  /** @type {function(...*):?} */
  function _SDL_OpenAudioDeviceStream(
  ) {
  abort('missing function: SDL_OpenAudioDeviceStream');
  }
  _SDL_OpenAudioDeviceStream.stub = true;

  /** @type {function(...*):?} */
  function _SDL_PutAudioStreamData(
  ) {
  abort('missing function: SDL_PutAudioStreamData');
  }
  _SDL_PutAudioStreamData.stub = true;

  /** @type {function(...*):?} */
  function _SDL_ReadIO(
  ) {
  abort('missing function: SDL_ReadIO');
  }
  _SDL_ReadIO.stub = true;

  /** @type {function(...*):?} */
  function _SDL_RenderGetD3D11Device(
  ) {
  abort('missing function: SDL_RenderGetD3D11Device');
  }
  _SDL_RenderGetD3D11Device.stub = true;

  /** @type {function(...*):?} */
  function _SDL_RenderGetD3D9Device(
  ) {
  abort('missing function: SDL_RenderGetD3D9Device');
  }
  _SDL_RenderGetD3D9Device.stub = true;

  /** @type {function(...*):?} */
  function _SDL_ResumeAudioDevice(
  ) {
  abort('missing function: SDL_ResumeAudioDevice');
  }
  _SDL_ResumeAudioDevice.stub = true;

  /** @type {function(...*):?} */
  function _SDL_SeekIO(
  ) {
  abort('missing function: SDL_SeekIO');
  }
  _SDL_SeekIO.stub = true;

  /** @type {function(...*):?} */
  function _SDL_SetCurrentThreadPriority(
  ) {
  abort('missing function: SDL_SetCurrentThreadPriority');
  }
  _SDL_SetCurrentThreadPriority.stub = true;

  /** @type {function(...*):?} */
  function _SDL_SetWindowsMessageHook(
  ) {
  abort('missing function: SDL_SetWindowsMessageHook');
  }
  _SDL_SetWindowsMessageHook.stub = true;

  /** @type {function(...*):?} */
  function _SDL_UIKitRunApp(
  ) {
  abort('missing function: SDL_UIKitRunApp');
  }
  _SDL_UIKitRunApp.stub = true;

  /** @type {function(...*):?} */
  function _SDL_WinRTGetDeviceFamily(
  ) {
  abort('missing function: SDL_WinRTGetDeviceFamily');
  }
  _SDL_WinRTGetDeviceFamily.stub = true;

  /** @type {function(...*):?} */
  function _SDL_WinRTRunApp(
  ) {
  abort('missing function: SDL_WinRTRunApp');
  }
  _SDL_WinRTRunApp.stub = true;

  /** @type {function(...*):?} */
  function _SDL_iPhoneSetAnimationCallback(
  ) {
  abort('missing function: SDL_iPhoneSetAnimationCallback');
  }
  _SDL_iPhoneSetAnimationCallback.stub = true;

  /** @type {function(...*):?} */
  function _SDL_iPhoneSetEventPump(
  ) {
  abort('missing function: SDL_iPhoneSetEventPump');
  }
  _SDL_iPhoneSetEventPump.stub = true;

  
    /**
     * Given a pointer 'idx' to a null-terminated UTF8-encoded string in the given
     * array that contains uint8 values, returns a copy of that string as a
     * Javascript String object.
     * heapOrArray is either a regular array, or a JavaScript typed array view.
     * @param {number} idx
     * @param {number=} maxBytesToRead
     * @return {string}
     */
  var UTF8ArrayToString = (heapOrArray, idx, maxBytesToRead) => {
      var endIdx = idx + maxBytesToRead;
  
      var str = '';
      while (!(idx >= endIdx)) {
        // For UTF8 byte structure, see:
        // http://en.wikipedia.org/wiki/UTF-8#Description
        // https://www.ietf.org/rfc/rfc2279.txt
        // https://tools.ietf.org/html/rfc3629
        var u0 = heapOrArray[idx++];
        // If not building with TextDecoder enabled, we don't know the string
        // length, so scan for \0 byte.
        // If building with TextDecoder, we know exactly at what byte index the
        // string ends, so checking for nulls here would be redundant.
        if (!u0) return str;
        if (!(u0 & 0x80)) { str += String.fromCharCode(u0); continue; }
        var u1 = heapOrArray[idx++] & 63;
        if ((u0 & 0xE0) == 0xC0) { str += String.fromCharCode(((u0 & 31) << 6) | u1); continue; }
        var u2 = heapOrArray[idx++] & 63;
        if ((u0 & 0xF0) == 0xE0) {
          u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
        } else {
          u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (heapOrArray[idx++] & 63);
        }
  
        if (u0 < 0x10000) {
          str += String.fromCharCode(u0);
        } else {
          var ch = u0 - 0x10000;
          str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF));
        }
      }
      return str;
    };
  
    /**
     * Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the
     * emscripten HEAP, returns a copy of that string as a Javascript String object.
     *
     * @param {number} ptr
     * @param {number=} maxBytesToRead - An optional length that specifies the
     *   maximum number of bytes to read. You can omit this parameter to scan the
     *   string until the first 0 byte. If maxBytesToRead is passed, and the string
     *   at [ptr, ptr+maxBytesToReadr[ contains a null byte in the middle, then the
     *   string will cut short at that byte index (i.e. maxBytesToRead will not
     *   produce a string of exact length [ptr, ptr+maxBytesToRead[) N.B. mixing
     *   frequent uses of UTF8ToString() with and without maxBytesToRead may throw
     *   JS JIT optimizations off, so it is worth to consider consistently using one
     * @return {string}
     */
  var UTF8ToString = (ptr, maxBytesToRead) => {
      return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : '';
    };
  var ___assert_fail = (condition, filename, line, func) => {
      abort(`Assertion failed: ${UTF8ToString(condition)}, at: ` + [filename ? UTF8ToString(filename) : 'unknown filename', line, func ? UTF8ToString(func) : 'unknown function']);
    };

  var ___call_sighandler = (fp, sig) => getWasmTableEntry(fp)(sig);

  var ___emscripten_init_main_thread_js = (tb) => {
      // Pass the thread address to the native code where they stored in wasm
      // globals which act as a form of TLS. Global constructors trying
      // to access this value will read the wrong value, but that is UB anyway.
      __emscripten_thread_init(
        tb,
        /*is_main=*/!ENVIRONMENT_IS_WORKER,
        /*is_runtime=*/1,
        /*can_block=*/!ENVIRONMENT_IS_WEB,
        /*default_stacksize=*/5242880,
        /*start_profiling=*/false,
      );
      PThread.threadInitTLS();
    };

  var ___emscripten_thread_cleanup = (thread) => {
      // Called when a thread needs to be cleaned up so it can be reused.
      // A thread is considered reusable when it either returns from its
      // entry point, calls pthread_exit, or acts upon a cancellation.
      // Detached threads are responsible for calling this themselves,
      // otherwise pthread_join is responsible for calling this.
      if (!ENVIRONMENT_IS_PTHREAD) cleanupThread(thread);
      else postMessage({ 'cmd': 'cleanupThread', 'thread': thread });
    };

  
  
  
  
  
  function pthreadCreateProxied(pthread_ptr, attr, startRoutine, arg) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(2, 0, 1, pthread_ptr, attr, startRoutine, arg);
  return ___pthread_create_js(pthread_ptr, attr, startRoutine, arg)
  }
  
  
  
  
  var ___pthread_create_js = (pthread_ptr, attr, startRoutine, arg) => {
      if (typeof SharedArrayBuffer == 'undefined') {
        err('Current environment does not support SharedArrayBuffer, pthreads are not available!');
        return 6;
      }
  
      // List of JS objects that will transfer ownership to the Worker hosting the thread
      var transferList = [];
      var error = 0;
  
      // Deduce which WebGL canvases (HTMLCanvasElements or OffscreenCanvases) should be passed over to the
      // Worker that hosts the spawned pthread.
      // Comma-delimited list of CSS selectors that must identify canvases by IDs: "#canvas1, #canvas2, ..."
      var transferredCanvasNames = attr ? HEAPU32[(((attr)+(40))>>2)] : 0;
      // Proxied canvases string pointer -1/MAX_PTR is used as a special token to
      // fetch whatever canvases were passed to build in
      // -sOFFSCREENCANVASES_TO_PTHREAD= command line.
      if (transferredCanvasNames == 4294967295) {
        transferredCanvasNames = '#canvas';
      } else
      transferredCanvasNames &&= UTF8ToString(transferredCanvasNames).trim();
      transferredCanvasNames &&= transferredCanvasNames.split(',');
  
      var offscreenCanvases = {}; // Dictionary of OffscreenCanvas objects we'll transfer to the created thread to own
      var moduleCanvasId = Module['canvas'] ? Module['canvas'].id : '';
      // Note that transferredCanvasNames might be null (so we cannot do a for-of loop).
      for (var i in transferredCanvasNames) {
        var name = transferredCanvasNames[i].trim();
        var offscreenCanvasInfo;
        try {
          if (name == '#canvas') {
            if (!Module['canvas']) {
              err(`pthread_create: could not find canvas with ID "${name}" to transfer to thread!`);
              error = 28;
              break;
            }
            name = Module['canvas'].id;
          }
          if (GL.offscreenCanvases[name]) {
            offscreenCanvasInfo = GL.offscreenCanvases[name];
            GL.offscreenCanvases[name] = null; // This thread no longer owns this canvas.
            if (Module['canvas'] instanceof OffscreenCanvas && name === Module['canvas'].id) Module['canvas'] = null;
          } else if (!ENVIRONMENT_IS_PTHREAD) {
            var canvas = (Module['canvas'] && Module['canvas'].id === name) ? Module['canvas'] : document.querySelector(name);
            if (!canvas) {
              err(`pthread_create: could not find canvas with ID "${name}" to transfer to thread!`);
              error = 28;
              break;
            }
            if (canvas.controlTransferredOffscreen) {
              err(`pthread_create: cannot transfer canvas with ID "${name}" to thread, since the current thread does not have control over it!`);
              error = 63; // Operation not permitted, some other thread is accessing the canvas.
              break;
            }
            if (canvas.transferControlToOffscreen) {
              // Create a shared information block in heap so that we can control
              // the canvas size from any thread.
              if (!canvas.canvasSharedPtr) {
                canvas.canvasSharedPtr = _malloc(12);
                HEAP32[((canvas.canvasSharedPtr)>>2)] = canvas.width;
                HEAP32[(((canvas.canvasSharedPtr)+(4))>>2)] = canvas.height;
                HEAPU32[(((canvas.canvasSharedPtr)+(8))>>2)] = 0; // pthread ptr to the thread that owns this canvas, filled in below.
              }
              offscreenCanvasInfo = {
                offscreenCanvas: canvas.transferControlToOffscreen(),
                canvasSharedPtr: canvas.canvasSharedPtr,
                id: canvas.id
              }
              // After calling canvas.transferControlToOffscreen(), it is no
              // longer possible to access certain operations on the canvas, such
              // as resizing it or obtaining GL contexts via it.
              // Use this field to remember that we have permanently converted
              // this Canvas to be controlled via an OffscreenCanvas (there is no
              // way to undo this in the spec)
              canvas.controlTransferredOffscreen = true;
            } else {
              err(`pthread_create: cannot transfer control of canvas "${name}" to pthread, because current browser does not support OffscreenCanvas!`);
              // If building with OFFSCREEN_FRAMEBUFFER=1 mode, we don't need to
              // be able to transfer control to offscreen, but WebGL can be
              // proxied from worker to main thread.
              err('pthread_create: Build with -sOFFSCREEN_FRAMEBUFFER to enable fallback proxying of GL commands from pthread to main thread.');
              return 52; // Function not implemented, browser doesn't have support for this.
            }
          }
          if (offscreenCanvasInfo) {
            transferList.push(offscreenCanvasInfo.offscreenCanvas);
            offscreenCanvases[offscreenCanvasInfo.id] = offscreenCanvasInfo;
          }
        } catch(e) {
          err(`pthread_create: failed to transfer control of canvas "${name}" to OffscreenCanvas! Error: ${e}`);
          return 28; // Hitting this might indicate an implementation bug or some other internal error
        }
      }
  
      // Synchronously proxy the thread creation to main thread if possible. If we
      // need to transfer ownership of objects, then proxy asynchronously via
      // postMessage.
      if (ENVIRONMENT_IS_PTHREAD && (transferList.length === 0 || error)) {
        return pthreadCreateProxied(pthread_ptr, attr, startRoutine, arg);
      }
  
      // If on the main thread, and accessing Canvas/OffscreenCanvas failed, abort
      // with the detected error.
      if (error) return error;
  
      // Register for each of the transferred canvases that the new thread now
      // owns the OffscreenCanvas.
      for (var canvas of Object.values(offscreenCanvases)) {
        // pthread ptr to the thread that owns this canvas.
        HEAPU32[(((canvas.canvasSharedPtr)+(8))>>2)] = pthread_ptr;
      }
  
      var threadParams = {
        startRoutine,
        pthread_ptr,
        arg,
        moduleCanvasId,
        offscreenCanvases,
        transferList,
      };
  
      if (ENVIRONMENT_IS_PTHREAD) {
        // The prepopulated pool of web workers that can host pthreads is stored
        // in the main JS thread. Therefore if a pthread is attempting to spawn a
        // new thread, the thread creation must be deferred to the main JS thread.
        threadParams.cmd = 'spawnThread';
        postMessage(threadParams, transferList);
        // When we defer thread creation this way, we have no way to detect thread
        // creation synchronously today, so we have to assume success and return 0.
        return 0;
      }
  
      // We are the main thread, so we have the pthread warmup pool in this
      // thread and can fire off JS thread creation directly ourselves.
      return spawnThread(threadParams);
    };

  var PATH = {
  isAbs:(path) => path.charAt(0) === '/',
  splitPath:(filename) => {
        var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
        return splitPathRe.exec(filename).slice(1);
      },
  normalizeArray:(parts, allowAboveRoot) => {
        // if the path tries to go above the root, `up` ends up > 0
        var up = 0;
        for (var i = parts.length - 1; i >= 0; i--) {
          var last = parts[i];
          if (last === '.') {
            parts.splice(i, 1);
          } else if (last === '..') {
            parts.splice(i, 1);
            up++;
          } else if (up) {
            parts.splice(i, 1);
            up--;
          }
        }
        // if the path is allowed to go above the root, restore leading ..s
        if (allowAboveRoot) {
          for (; up; up--) {
            parts.unshift('..');
          }
        }
        return parts;
      },
  normalize:(path) => {
        var isAbsolute = PATH.isAbs(path),
            trailingSlash = path.substr(-1) === '/';
        // Normalize the path
        path = PATH.normalizeArray(path.split('/').filter((p) => !!p), !isAbsolute).join('/');
        if (!path && !isAbsolute) {
          path = '.';
        }
        if (path && trailingSlash) {
          path += '/';
        }
        return (isAbsolute ? '/' : '') + path;
      },
  dirname:(path) => {
        var result = PATH.splitPath(path),
            root = result[0],
            dir = result[1];
        if (!root && !dir) {
          // No dirname whatsoever
          return '.';
        }
        if (dir) {
          // It has a dirname, strip trailing slash
          dir = dir.substr(0, dir.length - 1);
        }
        return root + dir;
      },
  basename:(path) => {
        // EMSCRIPTEN return '/'' for '/', not an empty string
        if (path === '/') return '/';
        path = PATH.normalize(path);
        path = path.replace(/\/$/, "");
        var lastSlash = path.lastIndexOf('/');
        if (lastSlash === -1) return path;
        return path.substr(lastSlash+1);
      },
  join:(...paths) => PATH.normalize(paths.join('/')),
  join2:(l, r) => PATH.normalize(l + '/' + r),
  };
  
  var initRandomFill = () => {
      if (typeof crypto == 'object' && typeof crypto['getRandomValues'] == 'function') {
        // for modern web browsers
        // like with most Web APIs, we can't use Web Crypto API directly on shared memory,
        // so we need to create an intermediate buffer and copy it to the destination
        return (view) => (
          view.set(crypto.getRandomValues(new Uint8Array(view.byteLength))),
          // Return the original view to match modern native implementations.
          view
        );
      } else
      if (ENVIRONMENT_IS_NODE) {
        // for nodejs with or without crypto support included
        try {
          var crypto_module = require('crypto');
          var randomFillSync = crypto_module['randomFillSync'];
          if (randomFillSync) {
            // nodejs with LTS crypto support
            return (view) => crypto_module['randomFillSync'](view);
          }
          // very old nodejs with the original crypto API
          var randomBytes = crypto_module['randomBytes'];
          return (view) => (
            view.set(randomBytes(view.byteLength)),
            // Return the original view to match modern native implementations.
            view
          );
        } catch (e) {
          // nodejs doesn't have crypto support
        }
      }
      // we couldn't find a proper implementation, as Math.random() is not suitable for /dev/random, see emscripten-core/emscripten/pull/7096
      abort('initRandomDevice');
    };
  var randomFill = (view) => {
      // Lazily init on the first invocation.
      return (randomFill = initRandomFill())(view);
    };
  
  
  
  var PATH_FS = {
  resolve:(...args) => {
        var resolvedPath = '',
          resolvedAbsolute = false;
        for (var i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
          var path = (i >= 0) ? args[i] : FS.cwd();
          // Skip empty and invalid entries
          if (typeof path != 'string') {
            throw new TypeError('Arguments to path.resolve must be strings');
          } else if (!path) {
            return ''; // an invalid portion invalidates the whole thing
          }
          resolvedPath = path + '/' + resolvedPath;
          resolvedAbsolute = PATH.isAbs(path);
        }
        // At this point the path should be resolved to a full absolute path, but
        // handle relative paths to be safe (might happen when process.cwd() fails)
        resolvedPath = PATH.normalizeArray(resolvedPath.split('/').filter((p) => !!p), !resolvedAbsolute).join('/');
        return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
      },
  relative:(from, to) => {
        from = PATH_FS.resolve(from).substr(1);
        to = PATH_FS.resolve(to).substr(1);
        function trim(arr) {
          var start = 0;
          for (; start < arr.length; start++) {
            if (arr[start] !== '') break;
          }
          var end = arr.length - 1;
          for (; end >= 0; end--) {
            if (arr[end] !== '') break;
          }
          if (start > end) return [];
          return arr.slice(start, end - start + 1);
        }
        var fromParts = trim(from.split('/'));
        var toParts = trim(to.split('/'));
        var length = Math.min(fromParts.length, toParts.length);
        var samePartsLength = length;
        for (var i = 0; i < length; i++) {
          if (fromParts[i] !== toParts[i]) {
            samePartsLength = i;
            break;
          }
        }
        var outputParts = [];
        for (var i = samePartsLength; i < fromParts.length; i++) {
          outputParts.push('..');
        }
        outputParts = outputParts.concat(toParts.slice(samePartsLength));
        return outputParts.join('/');
      },
  };
  
  
  
  var FS_stdin_getChar_buffer = [];
  
  var lengthBytesUTF8 = (str) => {
      var len = 0;
      for (var i = 0; i < str.length; ++i) {
        // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code
        // unit, not a Unicode code point of the character! So decode
        // UTF16->UTF32->UTF8.
        // See http://unicode.org/faq/utf_bom.html#utf16-3
        var c = str.charCodeAt(i); // possibly a lead surrogate
        if (c <= 0x7F) {
          len++;
        } else if (c <= 0x7FF) {
          len += 2;
        } else if (c >= 0xD800 && c <= 0xDFFF) {
          len += 4; ++i;
        } else {
          len += 3;
        }
      }
      return len;
    };
  
  var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
      // Parameter maxBytesToWrite is not optional. Negative values, 0, null,
      // undefined and false each don't write out any bytes.
      if (!(maxBytesToWrite > 0))
        return 0;
  
      var startIdx = outIdx;
      var endIdx = outIdx + maxBytesToWrite - 1; // -1 for string null terminator.
      for (var i = 0; i < str.length; ++i) {
        // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code
        // unit, not a Unicode code point of the character! So decode
        // UTF16->UTF32->UTF8.
        // See http://unicode.org/faq/utf_bom.html#utf16-3
        // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description
        // and https://www.ietf.org/rfc/rfc2279.txt
        // and https://tools.ietf.org/html/rfc3629
        var u = str.charCodeAt(i); // possibly a lead surrogate
        if (u >= 0xD800 && u <= 0xDFFF) {
          var u1 = str.charCodeAt(++i);
          u = 0x10000 + ((u & 0x3FF) << 10) | (u1 & 0x3FF);
        }
        if (u <= 0x7F) {
          if (outIdx >= endIdx) break;
          heap[outIdx++] = u;
        } else if (u <= 0x7FF) {
          if (outIdx + 1 >= endIdx) break;
          heap[outIdx++] = 0xC0 | (u >> 6);
          heap[outIdx++] = 0x80 | (u & 63);
        } else if (u <= 0xFFFF) {
          if (outIdx + 2 >= endIdx) break;
          heap[outIdx++] = 0xE0 | (u >> 12);
          heap[outIdx++] = 0x80 | ((u >> 6) & 63);
          heap[outIdx++] = 0x80 | (u & 63);
        } else {
          if (outIdx + 3 >= endIdx) break;
          heap[outIdx++] = 0xF0 | (u >> 18);
          heap[outIdx++] = 0x80 | ((u >> 12) & 63);
          heap[outIdx++] = 0x80 | ((u >> 6) & 63);
          heap[outIdx++] = 0x80 | (u & 63);
        }
      }
      // Null-terminate the pointer to the buffer.
      heap[outIdx] = 0;
      return outIdx - startIdx;
    };
  /** @type {function(string, boolean=, number=)} */
  function intArrayFromString(stringy, dontAddNull, length) {
    var len = length > 0 ? length : lengthBytesUTF8(stringy)+1;
    var u8array = new Array(len);
    var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
    if (dontAddNull) u8array.length = numBytesWritten;
    return u8array;
  }
  var FS_stdin_getChar = () => {
      if (!FS_stdin_getChar_buffer.length) {
        var result = null;
        if (ENVIRONMENT_IS_NODE) {
          // we will read data by chunks of BUFSIZE
          var BUFSIZE = 256;
          var buf = Buffer.alloc(BUFSIZE);
          var bytesRead = 0;
  
          // For some reason we must suppress a closure warning here, even though
          // fd definitely exists on process.stdin, and is even the proper way to
          // get the fd of stdin,
          // https://github.com/nodejs/help/issues/2136#issuecomment-523649904
          // This started to happen after moving this logic out of library_tty.js,
          // so it is related to the surrounding code in some unclear manner.
          /** @suppress {missingProperties} */
          var fd = process.stdin.fd;
  
          try {
            bytesRead = fs.readSync(fd, buf);
          } catch(e) {
            // Cross-platform differences: on Windows, reading EOF throws an exception, but on other OSes,
            // reading EOF returns 0. Uniformize behavior by treating the EOF exception to return 0.
            if (e.toString().includes('EOF')) bytesRead = 0;
            else throw e;
          }
  
          if (bytesRead > 0) {
            result = buf.slice(0, bytesRead).toString('utf-8');
          } else {
            result = null;
          }
        } else
        if (typeof window != 'undefined' &&
          typeof window.prompt == 'function') {
          // Browser.
          result = window.prompt('Input: ');  // returns null on cancel
          if (result !== null) {
            result += '\n';
          }
        } else if (typeof readline == 'function') {
          // Command line.
          result = readline();
          if (result !== null) {
            result += '\n';
          }
        }
        if (!result) {
          return null;
        }
        FS_stdin_getChar_buffer = intArrayFromString(result, true);
      }
      return FS_stdin_getChar_buffer.shift();
    };
  var TTY = {
  ttys:[],
  init() {
        // https://github.com/emscripten-core/emscripten/pull/1555
        // if (ENVIRONMENT_IS_NODE) {
        //   // currently, FS.init does not distinguish if process.stdin is a file or TTY
        //   // device, it always assumes it's a TTY device. because of this, we're forcing
        //   // process.stdin to UTF8 encoding to at least make stdin reading compatible
        //   // with text files until FS.init can be refactored.
        //   process.stdin.setEncoding('utf8');
        // }
      },
  shutdown() {
        // https://github.com/emscripten-core/emscripten/pull/1555
        // if (ENVIRONMENT_IS_NODE) {
        //   // inolen: any idea as to why node -e 'process.stdin.read()' wouldn't exit immediately (with process.stdin being a tty)?
        //   // isaacs: because now it's reading from the stream, you've expressed interest in it, so that read() kicks off a _read() which creates a ReadReq operation
        //   // inolen: I thought read() in that case was a synchronous operation that just grabbed some amount of buffered data if it exists?
        //   // isaacs: it is. but it also triggers a _read() call, which calls readStart() on the handle
        //   // isaacs: do process.stdin.pause() and i'd think it'd probably close the pending call
        //   process.stdin.pause();
        // }
      },
  register(dev, ops) {
        TTY.ttys[dev] = { input: [], output: [], ops: ops };
        FS.registerDevice(dev, TTY.stream_ops);
      },
  stream_ops:{
  open(stream) {
          var tty = TTY.ttys[stream.node.rdev];
          if (!tty) {
            throw new FS.ErrnoError(43);
          }
          stream.tty = tty;
          stream.seekable = false;
        },
  close(stream) {
          // flush any pending line data
          stream.tty.ops.fsync(stream.tty);
        },
  fsync(stream) {
          stream.tty.ops.fsync(stream.tty);
        },
  read(stream, buffer, offset, length, pos /* ignored */) {
          if (!stream.tty || !stream.tty.ops.get_char) {
            throw new FS.ErrnoError(60);
          }
          var bytesRead = 0;
          for (var i = 0; i < length; i++) {
            var result;
            try {
              result = stream.tty.ops.get_char(stream.tty);
            } catch (e) {
              throw new FS.ErrnoError(29);
            }
            if (result === undefined && bytesRead === 0) {
              throw new FS.ErrnoError(6);
            }
            if (result === null || result === undefined) break;
            bytesRead++;
            buffer[offset+i] = result;
          }
          if (bytesRead) {
            stream.node.timestamp = Date.now();
          }
          return bytesRead;
        },
  write(stream, buffer, offset, length, pos) {
          if (!stream.tty || !stream.tty.ops.put_char) {
            throw new FS.ErrnoError(60);
          }
          try {
            for (var i = 0; i < length; i++) {
              stream.tty.ops.put_char(stream.tty, buffer[offset+i]);
            }
          } catch (e) {
            throw new FS.ErrnoError(29);
          }
          if (length) {
            stream.node.timestamp = Date.now();
          }
          return i;
        },
  },
  default_tty_ops:{
  get_char(tty) {
          return FS_stdin_getChar();
        },
  put_char(tty, val) {
          if (val === null || val === 10) {
            out(UTF8ArrayToString(tty.output, 0));
            tty.output = [];
          } else {
            if (val != 0) tty.output.push(val); // val == 0 would cut text output off in the middle.
          }
        },
  fsync(tty) {
          if (tty.output && tty.output.length > 0) {
            out(UTF8ArrayToString(tty.output, 0));
            tty.output = [];
          }
        },
  ioctl_tcgets(tty) {
          // typical setting
          return {
            c_iflag: 25856,
            c_oflag: 5,
            c_cflag: 191,
            c_lflag: 35387,
            c_cc: [
              0x03, 0x1c, 0x7f, 0x15, 0x04, 0x00, 0x01, 0x00, 0x11, 0x13, 0x1a, 0x00,
              0x12, 0x0f, 0x17, 0x16, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
              0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            ]
          };
        },
  ioctl_tcsets(tty, optional_actions, data) {
          // currently just ignore
          return 0;
        },
  ioctl_tiocgwinsz(tty) {
          return [24, 80];
        },
  },
  default_tty1_ops:{
  put_char(tty, val) {
          if (val === null || val === 10) {
            err(UTF8ArrayToString(tty.output, 0));
            tty.output = [];
          } else {
            if (val != 0) tty.output.push(val);
          }
        },
  fsync(tty) {
          if (tty.output && tty.output.length > 0) {
            err(UTF8ArrayToString(tty.output, 0));
            tty.output = [];
          }
        },
  },
  };
  
  
  
  var alignMemory = (size, alignment) => {
      return Math.ceil(size / alignment) * alignment;
    };
  var mmapAlloc = (size) => {
      size = alignMemory(size, 65536);
      var ptr = _emscripten_builtin_memalign(65536, size);
      if (!ptr) return 0;
      return zeroMemory(ptr, size);
    };
  var MEMFS = {
  ops_table:null,
  mount(mount) {
        return MEMFS.createNode(null, '/', 16384 | 511 /* 0777 */, 0);
      },
  createNode(parent, name, mode, dev) {
        if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
          // no supported
          throw new FS.ErrnoError(63);
        }
        MEMFS.ops_table ||= {
          dir: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr,
              lookup: MEMFS.node_ops.lookup,
              mknod: MEMFS.node_ops.mknod,
              rename: MEMFS.node_ops.rename,
              unlink: MEMFS.node_ops.unlink,
              rmdir: MEMFS.node_ops.rmdir,
              readdir: MEMFS.node_ops.readdir,
              symlink: MEMFS.node_ops.symlink
            },
            stream: {
              llseek: MEMFS.stream_ops.llseek
            }
          },
          file: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr
            },
            stream: {
              llseek: MEMFS.stream_ops.llseek,
              read: MEMFS.stream_ops.read,
              write: MEMFS.stream_ops.write,
              allocate: MEMFS.stream_ops.allocate,
              mmap: MEMFS.stream_ops.mmap,
              msync: MEMFS.stream_ops.msync
            }
          },
          link: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr,
              readlink: MEMFS.node_ops.readlink
            },
            stream: {}
          },
          chrdev: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr
            },
            stream: FS.chrdev_stream_ops
          }
        };
        var node = FS.createNode(parent, name, mode, dev);
        if (FS.isDir(node.mode)) {
          node.node_ops = MEMFS.ops_table.dir.node;
          node.stream_ops = MEMFS.ops_table.dir.stream;
          node.contents = {};
        } else if (FS.isFile(node.mode)) {
          node.node_ops = MEMFS.ops_table.file.node;
          node.stream_ops = MEMFS.ops_table.file.stream;
          node.usedBytes = 0; // The actual number of bytes used in the typed array, as opposed to contents.length which gives the whole capacity.
          // When the byte data of the file is populated, this will point to either a typed array, or a normal JS array. Typed arrays are preferred
          // for performance, and used by default. However, typed arrays are not resizable like normal JS arrays are, so there is a small disk size
          // penalty involved for appending file writes that continuously grow a file similar to std::vector capacity vs used -scheme.
          node.contents = null; 
        } else if (FS.isLink(node.mode)) {
          node.node_ops = MEMFS.ops_table.link.node;
          node.stream_ops = MEMFS.ops_table.link.stream;
        } else if (FS.isChrdev(node.mode)) {
          node.node_ops = MEMFS.ops_table.chrdev.node;
          node.stream_ops = MEMFS.ops_table.chrdev.stream;
        }
        node.timestamp = Date.now();
        // add the new node to the parent
        if (parent) {
          parent.contents[name] = node;
          parent.timestamp = node.timestamp;
        }
        return node;
      },
  getFileDataAsTypedArray(node) {
        if (!node.contents) return new Uint8Array(0);
        if (node.contents.subarray) return node.contents.subarray(0, node.usedBytes); // Make sure to not return excess unused bytes.
        return new Uint8Array(node.contents);
      },
  expandFileStorage(node, newCapacity) {
        var prevCapacity = node.contents ? node.contents.length : 0;
        if (prevCapacity >= newCapacity) return; // No need to expand, the storage was already large enough.
        // Don't expand strictly to the given requested limit if it's only a very small increase, but instead geometrically grow capacity.
        // For small filesizes (<1MB), perform size*2 geometric increase, but for large sizes, do a much more conservative size*1.125 increase to
        // avoid overshooting the allocation cap by a very large margin.
        var CAPACITY_DOUBLING_MAX = 1024 * 1024;
        newCapacity = Math.max(newCapacity, (prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2.0 : 1.125)) >>> 0);
        if (prevCapacity != 0) newCapacity = Math.max(newCapacity, 256); // At minimum allocate 256b for each file when expanding.
        var oldContents = node.contents;
        node.contents = new Uint8Array(newCapacity); // Allocate new storage.
        if (node.usedBytes > 0) node.contents.set(oldContents.subarray(0, node.usedBytes), 0); // Copy old data over to the new storage.
      },
  resizeFileStorage(node, newSize) {
        if (node.usedBytes == newSize) return;
        if (newSize == 0) {
          node.contents = null; // Fully decommit when requesting a resize to zero.
          node.usedBytes = 0;
        } else {
          var oldContents = node.contents;
          node.contents = new Uint8Array(newSize); // Allocate new storage.
          if (oldContents) {
            node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes))); // Copy old data over to the new storage.
          }
          node.usedBytes = newSize;
        }
      },
  node_ops:{
  getattr(node) {
          var attr = {};
          // device numbers reuse inode numbers.
          attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
          attr.ino = node.id;
          attr.mode = node.mode;
          attr.nlink = 1;
          attr.uid = 0;
          attr.gid = 0;
          attr.rdev = node.rdev;
          if (FS.isDir(node.mode)) {
            attr.size = 4096;
          } else if (FS.isFile(node.mode)) {
            attr.size = node.usedBytes;
          } else if (FS.isLink(node.mode)) {
            attr.size = node.link.length;
          } else {
            attr.size = 0;
          }
          attr.atime = new Date(node.timestamp);
          attr.mtime = new Date(node.timestamp);
          attr.ctime = new Date(node.timestamp);
          // NOTE: In our implementation, st_blocks = Math.ceil(st_size/st_blksize),
          //       but this is not required by the standard.
          attr.blksize = 4096;
          attr.blocks = Math.ceil(attr.size / attr.blksize);
          return attr;
        },
  setattr(node, attr) {
          if (attr.mode !== undefined) {
            node.mode = attr.mode;
          }
          if (attr.timestamp !== undefined) {
            node.timestamp = attr.timestamp;
          }
          if (attr.size !== undefined) {
            MEMFS.resizeFileStorage(node, attr.size);
          }
        },
  lookup(parent, name) {
          throw FS.genericErrors[44];
        },
  mknod(parent, name, mode, dev) {
          return MEMFS.createNode(parent, name, mode, dev);
        },
  rename(old_node, new_dir, new_name) {
          // if we're overwriting a directory at new_name, make sure it's empty.
          if (FS.isDir(old_node.mode)) {
            var new_node;
            try {
              new_node = FS.lookupNode(new_dir, new_name);
            } catch (e) {
            }
            if (new_node) {
              for (var i in new_node.contents) {
                throw new FS.ErrnoError(55);
              }
            }
          }
          // do the internal rewiring
          delete old_node.parent.contents[old_node.name];
          old_node.parent.timestamp = Date.now()
          old_node.name = new_name;
          new_dir.contents[new_name] = old_node;
          new_dir.timestamp = old_node.parent.timestamp;
          old_node.parent = new_dir;
        },
  unlink(parent, name) {
          delete parent.contents[name];
          parent.timestamp = Date.now();
        },
  rmdir(parent, name) {
          var node = FS.lookupNode(parent, name);
          for (var i in node.contents) {
            throw new FS.ErrnoError(55);
          }
          delete parent.contents[name];
          parent.timestamp = Date.now();
        },
  readdir(node) {
          var entries = ['.', '..'];
          for (var key of Object.keys(node.contents)) {
            entries.push(key);
          }
          return entries;
        },
  symlink(parent, newname, oldpath) {
          var node = MEMFS.createNode(parent, newname, 511 /* 0777 */ | 40960, 0);
          node.link = oldpath;
          return node;
        },
  readlink(node) {
          if (!FS.isLink(node.mode)) {
            throw new FS.ErrnoError(28);
          }
          return node.link;
        },
  },
  stream_ops:{
  read(stream, buffer, offset, length, position) {
          var contents = stream.node.contents;
          if (position >= stream.node.usedBytes) return 0;
          var size = Math.min(stream.node.usedBytes - position, length);
          if (size > 8 && contents.subarray) { // non-trivial, and typed array
            buffer.set(contents.subarray(position, position + size), offset);
          } else {
            for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i];
          }
          return size;
        },
  write(stream, buffer, offset, length, position, canOwn) {
  
          if (!length) return 0;
          var node = stream.node;
          node.timestamp = Date.now();
  
          if (buffer.subarray && (!node.contents || node.contents.subarray)) { // This write is from a typed array to a typed array?
            if (canOwn) {
              node.contents = buffer.subarray(offset, offset + length);
              node.usedBytes = length;
              return length;
            } else if (node.usedBytes === 0 && position === 0) { // If this is a simple first write to an empty file, do a fast set since we don't need to care about old data.
              node.contents = buffer.slice(offset, offset + length);
              node.usedBytes = length;
              return length;
            } else if (position + length <= node.usedBytes) { // Writing to an already allocated and used subrange of the file?
              node.contents.set(buffer.subarray(offset, offset + length), position);
              return length;
            }
          }
  
          // Appending to an existing file and we need to reallocate, or source data did not come as a typed array.
          MEMFS.expandFileStorage(node, position+length);
          if (node.contents.subarray && buffer.subarray) {
            // Use typed array write which is available.
            node.contents.set(buffer.subarray(offset, offset + length), position);
          } else {
            for (var i = 0; i < length; i++) {
             node.contents[position + i] = buffer[offset + i]; // Or fall back to manual write if not.
            }
          }
          node.usedBytes = Math.max(node.usedBytes, position + length);
          return length;
        },
  llseek(stream, offset, whence) {
          var position = offset;
          if (whence === 1) {
            position += stream.position;
          } else if (whence === 2) {
            if (FS.isFile(stream.node.mode)) {
              position += stream.node.usedBytes;
            }
          }
          if (position < 0) {
            throw new FS.ErrnoError(28);
          }
          return position;
        },
  allocate(stream, offset, length) {
          MEMFS.expandFileStorage(stream.node, offset + length);
          stream.node.usedBytes = Math.max(stream.node.usedBytes, offset + length);
        },
  mmap(stream, length, position, prot, flags) {
          if (!FS.isFile(stream.node.mode)) {
            throw new FS.ErrnoError(43);
          }
          var ptr;
          var allocated;
          var contents = stream.node.contents;
          // Only make a new copy when MAP_PRIVATE is specified.
          if (!(flags & 2) && contents.buffer === HEAP8.buffer) {
            // We can't emulate MAP_SHARED when the file is not backed by the
            // buffer we're mapping to (e.g. the HEAP buffer).
            allocated = false;
            ptr = contents.byteOffset;
          } else {
            // Try to avoid unnecessary slices.
            if (position > 0 || position + length < contents.length) {
              if (contents.subarray) {
                contents = contents.subarray(position, position + length);
              } else {
                contents = Array.prototype.slice.call(contents, position, position + length);
              }
            }
            allocated = true;
            ptr = mmapAlloc(length);
            if (!ptr) {
              throw new FS.ErrnoError(48);
            }
            HEAP8.set(contents, ptr);
          }
          return { ptr, allocated };
        },
  msync(stream, buffer, offset, length, mmapFlags) {
          MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false);
          // should we check if bytesWritten and length are the same?
          return 0;
        },
  },
  };
  
  /** @param {boolean=} noRunDep */
  var asyncLoad = (url, onload, onerror, noRunDep) => {
      var dep = !noRunDep ? getUniqueRunDependency(`al ${url}`) : '';
      readAsync(url, (arrayBuffer) => {
        onload(new Uint8Array(arrayBuffer));
        if (dep) removeRunDependency(dep);
      }, (event) => {
        if (onerror) {
          onerror();
        } else {
          throw `Loading data file "${url}" failed.`;
        }
      });
      if (dep) addRunDependency(dep);
    };
  
  
  var FS_createDataFile = (parent, name, fileData, canRead, canWrite, canOwn) => {
      FS.createDataFile(parent, name, fileData, canRead, canWrite, canOwn);
    };
  
  var preloadPlugins = Module['preloadPlugins'] || [];
  var FS_handledByPreloadPlugin = (byteArray, fullname, finish, onerror) => {
      // Ensure plugins are ready.
      if (typeof Browser != 'undefined') Browser.init();
  
      var handled = false;
      preloadPlugins.forEach((plugin) => {
        if (handled) return;
        if (plugin['canHandle'](fullname)) {
          plugin['handle'](byteArray, fullname, finish, onerror);
          handled = true;
        }
      });
      return handled;
    };
  var FS_createPreloadedFile = (parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) => {
      // TODO we should allow people to just pass in a complete filename instead
      // of parent and name being that we just join them anyways
      var fullname = name ? PATH_FS.resolve(PATH.join2(parent, name)) : parent;
      var dep = getUniqueRunDependency(`cp ${fullname}`); // might have several active requests for the same fullname
      function processData(byteArray) {
        function finish(byteArray) {
          preFinish?.();
          if (!dontCreateFile) {
            FS_createDataFile(parent, name, byteArray, canRead, canWrite, canOwn);
          }
          onload?.();
          removeRunDependency(dep);
        }
        if (FS_handledByPreloadPlugin(byteArray, fullname, finish, () => {
          onerror?.();
          removeRunDependency(dep);
        })) {
          return;
        }
        finish(byteArray);
      }
      addRunDependency(dep);
      if (typeof url == 'string') {
        asyncLoad(url, processData, onerror);
      } else {
        processData(url);
      }
    };
  
  var FS_modeStringToFlags = (str) => {
      var flagModes = {
        'r': 0,
        'r+': 2,
        'w': 512 | 64 | 1,
        'w+': 512 | 64 | 2,
        'a': 1024 | 64 | 1,
        'a+': 1024 | 64 | 2,
      };
      var flags = flagModes[str];
      if (typeof flags == 'undefined') {
        throw new Error(`Unknown file open mode: ${str}`);
      }
      return flags;
    };
  
  var FS_getMode = (canRead, canWrite) => {
      var mode = 0;
      if (canRead) mode |= 292 | 73;
      if (canWrite) mode |= 146;
      return mode;
    };
  
  
  
  
  
  
  var IDBFS = {
  dbs:{
  },
  indexedDB:() => {
        if (typeof indexedDB != 'undefined') return indexedDB;
        var ret = null;
        if (typeof window == 'object') ret = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
        return ret;
      },
  DB_VERSION:21,
  DB_STORE_NAME:"FILE_DATA",
  mount:(...args) => MEMFS.mount(...args),
  syncfs:(mount, populate, callback) => {
        IDBFS.getLocalSet(mount, (err, local) => {
          if (err) return callback(err);
  
          IDBFS.getRemoteSet(mount, (err, remote) => {
            if (err) return callback(err);
  
            var src = populate ? remote : local;
            var dst = populate ? local : remote;
  
            IDBFS.reconcile(src, dst, callback);
          });
        });
      },
  quit:() => {
        Object.values(IDBFS.dbs).forEach((value) => value.close());
        IDBFS.dbs = {};
      },
  getDB:(name, callback) => {
        // check the cache first
        var db = IDBFS.dbs[name];
        if (db) {
          return callback(null, db);
        }
  
        var req;
        try {
          req = IDBFS.indexedDB().open(name, IDBFS.DB_VERSION);
        } catch (e) {
          return callback(e);
        }
        if (!req) {
          return callback("Unable to connect to IndexedDB");
        }
        req.onupgradeneeded = (e) => {
          var db = /** @type {IDBDatabase} */ (e.target.result);
          var transaction = e.target.transaction;
  
          var fileStore;
  
          if (db.objectStoreNames.contains(IDBFS.DB_STORE_NAME)) {
            fileStore = transaction.objectStore(IDBFS.DB_STORE_NAME);
          } else {
            fileStore = db.createObjectStore(IDBFS.DB_STORE_NAME);
          }
  
          if (!fileStore.indexNames.contains('timestamp')) {
            fileStore.createIndex('timestamp', 'timestamp', { unique: false });
          }
        };
        req.onsuccess = () => {
          db = /** @type {IDBDatabase} */ (req.result);
  
          // add to the cache
          IDBFS.dbs[name] = db;
          callback(null, db);
        };
        req.onerror = (e) => {
          callback(e.target.error);
          e.preventDefault();
        };
      },
  getLocalSet:(mount, callback) => {
        var entries = {};
  
        function isRealDir(p) {
          return p !== '.' && p !== '..';
        };
        function toAbsolute(root) {
          return (p) => PATH.join2(root, p);
        };
  
        var check = FS.readdir(mount.mountpoint).filter(isRealDir).map(toAbsolute(mount.mountpoint));
  
        while (check.length) {
          var path = check.pop();
          var stat;
  
          try {
            stat = FS.stat(path);
          } catch (e) {
            return callback(e);
          }
  
          if (FS.isDir(stat.mode)) {
            check.push(...FS.readdir(path).filter(isRealDir).map(toAbsolute(path)));
          }
  
          entries[path] = { 'timestamp': stat.mtime };
        }
  
        return callback(null, { type: 'local', entries: entries });
      },
  getRemoteSet:(mount, callback) => {
        var entries = {};
  
        IDBFS.getDB(mount.mountpoint, (err, db) => {
          if (err) return callback(err);
  
          try {
            var transaction = db.transaction([IDBFS.DB_STORE_NAME], 'readonly');
            transaction.onerror = (e) => {
              callback(e.target.error);
              e.preventDefault();
            };
  
            var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
            var index = store.index('timestamp');
  
            index.openKeyCursor().onsuccess = (event) => {
              var cursor = event.target.result;
  
              if (!cursor) {
                return callback(null, { type: 'remote', db, entries });
              }
  
              entries[cursor.primaryKey] = { 'timestamp': cursor.key };
  
              cursor.continue();
            };
          } catch (e) {
            return callback(e);
          }
        });
      },
  loadLocalEntry:(path, callback) => {
        var stat, node;
  
        try {
          var lookup = FS.lookupPath(path);
          node = lookup.node;
          stat = FS.stat(path);
        } catch (e) {
          return callback(e);
        }
  
        if (FS.isDir(stat.mode)) {
          return callback(null, { 'timestamp': stat.mtime, 'mode': stat.mode });
        } else if (FS.isFile(stat.mode)) {
          // Performance consideration: storing a normal JavaScript array to a IndexedDB is much slower than storing a typed array.
          // Therefore always convert the file contents to a typed array first before writing the data to IndexedDB.
          node.contents = MEMFS.getFileDataAsTypedArray(node);
          return callback(null, { 'timestamp': stat.mtime, 'mode': stat.mode, 'contents': node.contents });
        } else {
          return callback(new Error('node type not supported'));
        }
      },
  storeLocalEntry:(path, entry, callback) => {
        try {
          if (FS.isDir(entry['mode'])) {
            FS.mkdirTree(path, entry['mode']);
          } else if (FS.isFile(entry['mode'])) {
            FS.writeFile(path, entry['contents'], { canOwn: true });
          } else {
            return callback(new Error('node type not supported'));
          }
  
          FS.chmod(path, entry['mode']);
          FS.utime(path, entry['timestamp'], entry['timestamp']);
        } catch (e) {
          return callback(e);
        }
  
        callback(null);
      },
  removeLocalEntry:(path, callback) => {
        try {
          var stat = FS.stat(path);
  
          if (FS.isDir(stat.mode)) {
            FS.rmdir(path);
          } else if (FS.isFile(stat.mode)) {
            FS.unlink(path);
          }
        } catch (e) {
          return callback(e);
        }
  
        callback(null);
      },
  loadRemoteEntry:(store, path, callback) => {
        var req = store.get(path);
        req.onsuccess = (event) => callback(null, event.target.result);
        req.onerror = (e) => {
          callback(e.target.error);
          e.preventDefault();
        };
      },
  storeRemoteEntry:(store, path, entry, callback) => {
        try {
          var req = store.put(entry, path);
        } catch (e) {
          callback(e);
          return;
        }
        req.onsuccess = (event) => callback();
        req.onerror = (e) => {
          callback(e.target.error);
          e.preventDefault();
        };
      },
  removeRemoteEntry:(store, path, callback) => {
        var req = store.delete(path);
        req.onsuccess = (event) => callback();
        req.onerror = (e) => {
          callback(e.target.error);
          e.preventDefault();
        };
      },
  reconcile:(src, dst, callback) => {
        var total = 0;
  
        var create = [];
        Object.keys(src.entries).forEach(function (key) {
          var e = src.entries[key];
          var e2 = dst.entries[key];
          if (!e2 || e['timestamp'].getTime() != e2['timestamp'].getTime()) {
            create.push(key);
            total++;
          }
        });
  
        var remove = [];
        Object.keys(dst.entries).forEach(function (key) {
          if (!src.entries[key]) {
            remove.push(key);
            total++;
          }
        });
  
        if (!total) {
          return callback(null);
        }
  
        var errored = false;
        var db = src.type === 'remote' ? src.db : dst.db;
        var transaction = db.transaction([IDBFS.DB_STORE_NAME], 'readwrite');
        var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
  
        function done(err) {
          if (err && !errored) {
            errored = true;
            return callback(err);
          }
        };
  
        // transaction may abort if (for example) there is a QuotaExceededError
        transaction.onerror = transaction.onabort = (e) => {
          done(e.target.error);
          e.preventDefault();
        };
  
        transaction.oncomplete = (e) => {
          if (!errored) {
            callback(null);
          }
        };
  
        // sort paths in ascending order so directory entries are created
        // before the files inside them
        create.sort().forEach((path) => {
          if (dst.type === 'local') {
            IDBFS.loadRemoteEntry(store, path, (err, entry) => {
              if (err) return done(err);
              IDBFS.storeLocalEntry(path, entry, done);
            });
          } else {
            IDBFS.loadLocalEntry(path, (err, entry) => {
              if (err) return done(err);
              IDBFS.storeRemoteEntry(store, path, entry, done);
            });
          }
        });
  
        // sort paths in descending order so files are deleted before their
        // parent directories
        remove.sort().reverse().forEach((path) => {
          if (dst.type === 'local') {
            IDBFS.removeLocalEntry(path, done);
          } else {
            IDBFS.removeRemoteEntry(store, path, done);
          }
        });
      },
  };
  var FS = {
  root:null,
  mounts:[],
  devices:{
  },
  streams:[],
  nextInode:1,
  nameTable:null,
  currentPath:"/",
  initialized:false,
  ignorePermissions:true,
  ErrnoError:class {
        // We set the `name` property to be able to identify `FS.ErrnoError`
        // - the `name` is a standard ECMA-262 property of error objects. Kind of good to have it anyway.
        // - when using PROXYFS, an error can come from an underlying FS
        // as different FS objects have their own FS.ErrnoError each,
        // the test `err instanceof FS.ErrnoError` won't detect an error coming from another filesystem, causing bugs.
        // we'll use the reliable test `err.name == "ErrnoError"` instead
        constructor(errno) {
          // TODO(sbc): Use the inline member declaration syntax once we
          // support it in acorn and closure.
          this.name = 'ErrnoError';
          this.errno = errno;
        }
      },
  genericErrors:{
  },
  filesystems:null,
  syncFSRequests:0,
  FSStream:class {
        constructor() {
          // TODO(https://github.com/emscripten-core/emscripten/issues/21414):
          // Use inline field declarations.
          this.shared = {};
        }
        get object() {
          return this.node;
        }
        set object(val) {
          this.node = val;
        }
        get isRead() {
          return (this.flags & 2097155) !== 1;
        }
        get isWrite() {
          return (this.flags & 2097155) !== 0;
        }
        get isAppend() {
          return (this.flags & 1024);
        }
        get flags() {
          return this.shared.flags;
        }
        set flags(val) {
          this.shared.flags = val;
        }
        get position() {
          return this.shared.position;
        }
        set position(val) {
          this.shared.position = val;
        }
      },
  FSNode:class {
        constructor(parent, name, mode, rdev) {
          if (!parent) {
            parent = this;  // root node sets parent to itself
          }
          this.parent = parent;
          this.mount = parent.mount;
          this.mounted = null;
          this.id = FS.nextInode++;
          this.name = name;
          this.mode = mode;
          this.node_ops = {};
          this.stream_ops = {};
          this.rdev = rdev;
          this.readMode = 292/*292*/ | 73/*73*/;
          this.writeMode = 146/*146*/;
        }
        get read() {
          return (this.mode & this.readMode) === this.readMode;
        }
        set read(val) {
          val ? this.mode |= this.readMode : this.mode &= ~this.readMode;
        }
        get write() {
          return (this.mode & this.writeMode) === this.writeMode;
        }
        set write(val) {
          val ? this.mode |= this.writeMode : this.mode &= ~this.writeMode;
        }
        get isFolder() {
          return FS.isDir(this.mode);
        }
        get isDevice() {
          return FS.isChrdev(this.mode);
        }
      },
  lookupPath(path, opts = {}) {
        path = PATH_FS.resolve(path);
  
        if (!path) return { path: '', node: null };
  
        var defaults = {
          follow_mount: true,
          recurse_count: 0
        };
        opts = Object.assign(defaults, opts)
  
        if (opts.recurse_count > 8) {  // max recursive lookup of 8
          throw new FS.ErrnoError(32);
        }
  
        // split the absolute path
        var parts = path.split('/').filter((p) => !!p);
  
        // start at the root
        var current = FS.root;
        var current_path = '/';
  
        for (var i = 0; i < parts.length; i++) {
          var islast = (i === parts.length-1);
          if (islast && opts.parent) {
            // stop resolving
            break;
          }
  
          current = FS.lookupNode(current, parts[i]);
          current_path = PATH.join2(current_path, parts[i]);
  
          // jump to the mount's root node if this is a mountpoint
          if (FS.isMountpoint(current)) {
            if (!islast || (islast && opts.follow_mount)) {
              current = current.mounted.root;
            }
          }
  
          // by default, lookupPath will not follow a symlink if it is the final path component.
          // setting opts.follow = true will override this behavior.
          if (!islast || opts.follow) {
            var count = 0;
            while (FS.isLink(current.mode)) {
              var link = FS.readlink(current_path);
              current_path = PATH_FS.resolve(PATH.dirname(current_path), link);
  
              var lookup = FS.lookupPath(current_path, { recurse_count: opts.recurse_count + 1 });
              current = lookup.node;
  
              if (count++ > 40) {  // limit max consecutive symlinks to 40 (SYMLOOP_MAX).
                throw new FS.ErrnoError(32);
              }
            }
          }
        }
  
        return { path: current_path, node: current };
      },
  getPath(node) {
        var path;
        while (true) {
          if (FS.isRoot(node)) {
            var mount = node.mount.mountpoint;
            if (!path) return mount;
            return mount[mount.length-1] !== '/' ? `${mount}/${path}` : mount + path;
          }
          path = path ? `${node.name}/${path}` : node.name;
          node = node.parent;
        }
      },
  hashName(parentid, name) {
        var hash = 0;
  
        for (var i = 0; i < name.length; i++) {
          hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
        }
        return ((parentid + hash) >>> 0) % FS.nameTable.length;
      },
  hashAddNode(node) {
        var hash = FS.hashName(node.parent.id, node.name);
        node.name_next = FS.nameTable[hash];
        FS.nameTable[hash] = node;
      },
  hashRemoveNode(node) {
        var hash = FS.hashName(node.parent.id, node.name);
        if (FS.nameTable[hash] === node) {
          FS.nameTable[hash] = node.name_next;
        } else {
          var current = FS.nameTable[hash];
          while (current) {
            if (current.name_next === node) {
              current.name_next = node.name_next;
              break;
            }
            current = current.name_next;
          }
        }
      },
  lookupNode(parent, name) {
        var errCode = FS.mayLookup(parent);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        var hash = FS.hashName(parent.id, name);
        for (var node = FS.nameTable[hash]; node; node = node.name_next) {
          var nodeName = node.name;
          if (node.parent.id === parent.id && nodeName === name) {
            return node;
          }
        }
        // if we failed to find it in the cache, call into the VFS
        return FS.lookup(parent, name);
      },
  createNode(parent, name, mode, rdev) {
        var node = new FS.FSNode(parent, name, mode, rdev);
  
        FS.hashAddNode(node);
  
        return node;
      },
  destroyNode(node) {
        FS.hashRemoveNode(node);
      },
  isRoot(node) {
        return node === node.parent;
      },
  isMountpoint(node) {
        return !!node.mounted;
      },
  isFile(mode) {
        return (mode & 61440) === 32768;
      },
  isDir(mode) {
        return (mode & 61440) === 16384;
      },
  isLink(mode) {
        return (mode & 61440) === 40960;
      },
  isChrdev(mode) {
        return (mode & 61440) === 8192;
      },
  isBlkdev(mode) {
        return (mode & 61440) === 24576;
      },
  isFIFO(mode) {
        return (mode & 61440) === 4096;
      },
  isSocket(mode) {
        return (mode & 49152) === 49152;
      },
  flagsToPermissionString(flag) {
        var perms = ['r', 'w', 'rw'][flag & 3];
        if ((flag & 512)) {
          perms += 'w';
        }
        return perms;
      },
  nodePermissions(node, perms) {
        if (FS.ignorePermissions) {
          return 0;
        }
        // return 0 if any user, group or owner bits are set.
        if (perms.includes('r') && !(node.mode & 292)) {
          return 2;
        } else if (perms.includes('w') && !(node.mode & 146)) {
          return 2;
        } else if (perms.includes('x') && !(node.mode & 73)) {
          return 2;
        }
        return 0;
      },
  mayLookup(dir) {
        if (!FS.isDir(dir.mode)) return 54;
        var errCode = FS.nodePermissions(dir, 'x');
        if (errCode) return errCode;
        if (!dir.node_ops.lookup) return 2;
        return 0;
      },
  mayCreate(dir, name) {
        try {
          var node = FS.lookupNode(dir, name);
          return 20;
        } catch (e) {
        }
        return FS.nodePermissions(dir, 'wx');
      },
  mayDelete(dir, name, isdir) {
        var node;
        try {
          node = FS.lookupNode(dir, name);
        } catch (e) {
          return e.errno;
        }
        var errCode = FS.nodePermissions(dir, 'wx');
        if (errCode) {
          return errCode;
        }
        if (isdir) {
          if (!FS.isDir(node.mode)) {
            return 54;
          }
          if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
            return 10;
          }
        } else {
          if (FS.isDir(node.mode)) {
            return 31;
          }
        }
        return 0;
      },
  mayOpen(node, flags) {
        if (!node) {
          return 44;
        }
        if (FS.isLink(node.mode)) {
          return 32;
        } else if (FS.isDir(node.mode)) {
          if (FS.flagsToPermissionString(flags) !== 'r' || // opening for write
              (flags & 512)) { // TODO: check for O_SEARCH? (== search for dir only)
            return 31;
          }
        }
        return FS.nodePermissions(node, FS.flagsToPermissionString(flags));
      },
  MAX_OPEN_FDS:4096,
  nextfd() {
        for (var fd = 0; fd <= FS.MAX_OPEN_FDS; fd++) {
          if (!FS.streams[fd]) {
            return fd;
          }
        }
        throw new FS.ErrnoError(33);
      },
  getStreamChecked(fd) {
        var stream = FS.getStream(fd);
        if (!stream) {
          throw new FS.ErrnoError(8);
        }
        return stream;
      },
  getStream:(fd) => FS.streams[fd],
  createStream(stream, fd = -1) {
  
        // clone it, so we can return an instance of FSStream
        stream = Object.assign(new FS.FSStream(), stream);
        if (fd == -1) {
          fd = FS.nextfd();
        }
        stream.fd = fd;
        FS.streams[fd] = stream;
        return stream;
      },
  closeStream(fd) {
        FS.streams[fd] = null;
      },
  dupStream(origStream, fd = -1) {
        var stream = FS.createStream(origStream, fd);
        stream.stream_ops?.dup?.(stream);
        return stream;
      },
  chrdev_stream_ops:{
  open(stream) {
          var device = FS.getDevice(stream.node.rdev);
          // override node's stream ops with the device's
          stream.stream_ops = device.stream_ops;
          // forward the open call
          stream.stream_ops.open?.(stream);
        },
  llseek() {
          throw new FS.ErrnoError(70);
        },
  },
  major:(dev) => ((dev) >> 8),
  minor:(dev) => ((dev) & 0xff),
  makedev:(ma, mi) => ((ma) << 8 | (mi)),
  registerDevice(dev, ops) {
        FS.devices[dev] = { stream_ops: ops };
      },
  getDevice:(dev) => FS.devices[dev],
  getMounts(mount) {
        var mounts = [];
        var check = [mount];
  
        while (check.length) {
          var m = check.pop();
  
          mounts.push(m);
  
          check.push(...m.mounts);
        }
  
        return mounts;
      },
  syncfs(populate, callback) {
        if (typeof populate == 'function') {
          callback = populate;
          populate = false;
        }
  
        FS.syncFSRequests++;
  
        if (FS.syncFSRequests > 1) {
          err(`warning: ${FS.syncFSRequests} FS.syncfs operations in flight at once, probably just doing extra work`);
        }
  
        var mounts = FS.getMounts(FS.root.mount);
        var completed = 0;
  
        function doCallback(errCode) {
          FS.syncFSRequests--;
          return callback(errCode);
        }
  
        function done(errCode) {
          if (errCode) {
            if (!done.errored) {
              done.errored = true;
              return doCallback(errCode);
            }
            return;
          }
          if (++completed >= mounts.length) {
            doCallback(null);
          }
        };
  
        // sync all mounts
        mounts.forEach((mount) => {
          if (!mount.type.syncfs) {
            return done(null);
          }
          mount.type.syncfs(mount, populate, done);
        });
      },
  mount(type, opts, mountpoint) {
        var root = mountpoint === '/';
        var pseudo = !mountpoint;
        var node;
  
        if (root && FS.root) {
          throw new FS.ErrnoError(10);
        } else if (!root && !pseudo) {
          var lookup = FS.lookupPath(mountpoint, { follow_mount: false });
  
          mountpoint = lookup.path;  // use the absolute path
          node = lookup.node;
  
          if (FS.isMountpoint(node)) {
            throw new FS.ErrnoError(10);
          }
  
          if (!FS.isDir(node.mode)) {
            throw new FS.ErrnoError(54);
          }
        }
  
        var mount = {
          type,
          opts,
          mountpoint,
          mounts: []
        };
  
        // create a root node for the fs
        var mountRoot = type.mount(mount);
        mountRoot.mount = mount;
        mount.root = mountRoot;
  
        if (root) {
          FS.root = mountRoot;
        } else if (node) {
          // set as a mountpoint
          node.mounted = mount;
  
          // add the new mount to the current mount's children
          if (node.mount) {
            node.mount.mounts.push(mount);
          }
        }
  
        return mountRoot;
      },
  unmount(mountpoint) {
        var lookup = FS.lookupPath(mountpoint, { follow_mount: false });
  
        if (!FS.isMountpoint(lookup.node)) {
          throw new FS.ErrnoError(28);
        }
  
        // destroy the nodes for this mount, and all its child mounts
        var node = lookup.node;
        var mount = node.mounted;
        var mounts = FS.getMounts(mount);
  
        Object.keys(FS.nameTable).forEach((hash) => {
          var current = FS.nameTable[hash];
  
          while (current) {
            var next = current.name_next;
  
            if (mounts.includes(current.mount)) {
              FS.destroyNode(current);
            }
  
            current = next;
          }
        });
  
        // no longer a mountpoint
        node.mounted = null;
  
        // remove this mount from the child mounts
        var idx = node.mount.mounts.indexOf(mount);
        node.mount.mounts.splice(idx, 1);
      },
  lookup(parent, name) {
        return parent.node_ops.lookup(parent, name);
      },
  mknod(path, mode, dev) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        if (!name || name === '.' || name === '..') {
          throw new FS.ErrnoError(28);
        }
        var errCode = FS.mayCreate(parent, name);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.mknod) {
          throw new FS.ErrnoError(63);
        }
        return parent.node_ops.mknod(parent, name, mode, dev);
      },
  create(path, mode) {
        mode = mode !== undefined ? mode : 438 /* 0666 */;
        mode &= 4095;
        mode |= 32768;
        return FS.mknod(path, mode, 0);
      },
  mkdir(path, mode) {
        mode = mode !== undefined ? mode : 511 /* 0777 */;
        mode &= 511 | 512;
        mode |= 16384;
        return FS.mknod(path, mode, 0);
      },
  mkdirTree(path, mode) {
        var dirs = path.split('/');
        var d = '';
        for (var i = 0; i < dirs.length; ++i) {
          if (!dirs[i]) continue;
          d += '/' + dirs[i];
          try {
            FS.mkdir(d, mode);
          } catch(e) {
            if (e.errno != 20) throw e;
          }
        }
      },
  mkdev(path, mode, dev) {
        if (typeof dev == 'undefined') {
          dev = mode;
          mode = 438 /* 0666 */;
        }
        mode |= 8192;
        return FS.mknod(path, mode, dev);
      },
  symlink(oldpath, newpath) {
        if (!PATH_FS.resolve(oldpath)) {
          throw new FS.ErrnoError(44);
        }
        var lookup = FS.lookupPath(newpath, { parent: true });
        var parent = lookup.node;
        if (!parent) {
          throw new FS.ErrnoError(44);
        }
        var newname = PATH.basename(newpath);
        var errCode = FS.mayCreate(parent, newname);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.symlink) {
          throw new FS.ErrnoError(63);
        }
        return parent.node_ops.symlink(parent, newname, oldpath);
      },
  rename(old_path, new_path) {
        var old_dirname = PATH.dirname(old_path);
        var new_dirname = PATH.dirname(new_path);
        var old_name = PATH.basename(old_path);
        var new_name = PATH.basename(new_path);
        // parents must exist
        var lookup, old_dir, new_dir;
  
        // let the errors from non existent directories percolate up
        lookup = FS.lookupPath(old_path, { parent: true });
        old_dir = lookup.node;
        lookup = FS.lookupPath(new_path, { parent: true });
        new_dir = lookup.node;
  
        if (!old_dir || !new_dir) throw new FS.ErrnoError(44);
        // need to be part of the same mount
        if (old_dir.mount !== new_dir.mount) {
          throw new FS.ErrnoError(75);
        }
        // source must exist
        var old_node = FS.lookupNode(old_dir, old_name);
        // old path should not be an ancestor of the new path
        var relative = PATH_FS.relative(old_path, new_dirname);
        if (relative.charAt(0) !== '.') {
          throw new FS.ErrnoError(28);
        }
        // new path should not be an ancestor of the old path
        relative = PATH_FS.relative(new_path, old_dirname);
        if (relative.charAt(0) !== '.') {
          throw new FS.ErrnoError(55);
        }
        // see if the new path already exists
        var new_node;
        try {
          new_node = FS.lookupNode(new_dir, new_name);
        } catch (e) {
          // not fatal
        }
        // early out if nothing needs to change
        if (old_node === new_node) {
          return;
        }
        // we'll need to delete the old entry
        var isdir = FS.isDir(old_node.mode);
        var errCode = FS.mayDelete(old_dir, old_name, isdir);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        // need delete permissions if we'll be overwriting.
        // need create permissions if new doesn't already exist.
        errCode = new_node ?
          FS.mayDelete(new_dir, new_name, isdir) :
          FS.mayCreate(new_dir, new_name);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        if (!old_dir.node_ops.rename) {
          throw new FS.ErrnoError(63);
        }
        if (FS.isMountpoint(old_node) || (new_node && FS.isMountpoint(new_node))) {
          throw new FS.ErrnoError(10);
        }
        // if we are going to change the parent, check write permissions
        if (new_dir !== old_dir) {
          errCode = FS.nodePermissions(old_dir, 'w');
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
        }
        // remove the node from the lookup hash
        FS.hashRemoveNode(old_node);
        // do the underlying fs rename
        try {
          old_dir.node_ops.rename(old_node, new_dir, new_name);
        } catch (e) {
          throw e;
        } finally {
          // add the node back to the hash (in case node_ops.rename
          // changed its name)
          FS.hashAddNode(old_node);
        }
      },
  rmdir(path) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var errCode = FS.mayDelete(parent, name, true);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.rmdir) {
          throw new FS.ErrnoError(63);
        }
        if (FS.isMountpoint(node)) {
          throw new FS.ErrnoError(10);
        }
        parent.node_ops.rmdir(parent, name);
        FS.destroyNode(node);
      },
  readdir(path) {
        var lookup = FS.lookupPath(path, { follow: true });
        var node = lookup.node;
        if (!node.node_ops.readdir) {
          throw new FS.ErrnoError(54);
        }
        return node.node_ops.readdir(node);
      },
  unlink(path) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        if (!parent) {
          throw new FS.ErrnoError(44);
        }
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var errCode = FS.mayDelete(parent, name, false);
        if (errCode) {
          // According to POSIX, we should map EISDIR to EPERM, but
          // we instead do what Linux does (and we must, as we use
          // the musl linux libc).
          throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.unlink) {
          throw new FS.ErrnoError(63);
        }
        if (FS.isMountpoint(node)) {
          throw new FS.ErrnoError(10);
        }
        parent.node_ops.unlink(parent, name);
        FS.destroyNode(node);
      },
  readlink(path) {
        var lookup = FS.lookupPath(path);
        var link = lookup.node;
        if (!link) {
          throw new FS.ErrnoError(44);
        }
        if (!link.node_ops.readlink) {
          throw new FS.ErrnoError(28);
        }
        return PATH_FS.resolve(FS.getPath(link.parent), link.node_ops.readlink(link));
      },
  stat(path, dontFollow) {
        var lookup = FS.lookupPath(path, { follow: !dontFollow });
        var node = lookup.node;
        if (!node) {
          throw new FS.ErrnoError(44);
        }
        if (!node.node_ops.getattr) {
          throw new FS.ErrnoError(63);
        }
        return node.node_ops.getattr(node);
      },
  lstat(path) {
        return FS.stat(path, true);
      },
  chmod(path, mode, dontFollow) {
        var node;
        if (typeof path == 'string') {
          var lookup = FS.lookupPath(path, { follow: !dontFollow });
          node = lookup.node;
        } else {
          node = path;
        }
        if (!node.node_ops.setattr) {
          throw new FS.ErrnoError(63);
        }
        node.node_ops.setattr(node, {
          mode: (mode & 4095) | (node.mode & ~4095),
          timestamp: Date.now()
        });
      },
  lchmod(path, mode) {
        FS.chmod(path, mode, true);
      },
  fchmod(fd, mode) {
        var stream = FS.getStreamChecked(fd);
        FS.chmod(stream.node, mode);
      },
  chown(path, uid, gid, dontFollow) {
        var node;
        if (typeof path == 'string') {
          var lookup = FS.lookupPath(path, { follow: !dontFollow });
          node = lookup.node;
        } else {
          node = path;
        }
        if (!node.node_ops.setattr) {
          throw new FS.ErrnoError(63);
        }
        node.node_ops.setattr(node, {
          timestamp: Date.now()
          // we ignore the uid / gid for now
        });
      },
  lchown(path, uid, gid) {
        FS.chown(path, uid, gid, true);
      },
  fchown(fd, uid, gid) {
        var stream = FS.getStreamChecked(fd);
        FS.chown(stream.node, uid, gid);
      },
  truncate(path, len) {
        if (len < 0) {
          throw new FS.ErrnoError(28);
        }
        var node;
        if (typeof path == 'string') {
          var lookup = FS.lookupPath(path, { follow: true });
          node = lookup.node;
        } else {
          node = path;
        }
        if (!node.node_ops.setattr) {
          throw new FS.ErrnoError(63);
        }
        if (FS.isDir(node.mode)) {
          throw new FS.ErrnoError(31);
        }
        if (!FS.isFile(node.mode)) {
          throw new FS.ErrnoError(28);
        }
        var errCode = FS.nodePermissions(node, 'w');
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        node.node_ops.setattr(node, {
          size: len,
          timestamp: Date.now()
        });
      },
  ftruncate(fd, len) {
        var stream = FS.getStreamChecked(fd);
        if ((stream.flags & 2097155) === 0) {
          throw new FS.ErrnoError(28);
        }
        FS.truncate(stream.node, len);
      },
  utime(path, atime, mtime) {
        var lookup = FS.lookupPath(path, { follow: true });
        var node = lookup.node;
        node.node_ops.setattr(node, {
          timestamp: Math.max(atime, mtime)
        });
      },
  open(path, flags, mode) {
        if (path === "") {
          throw new FS.ErrnoError(44);
        }
        flags = typeof flags == 'string' ? FS_modeStringToFlags(flags) : flags;
        mode = typeof mode == 'undefined' ? 438 /* 0666 */ : mode;
        if ((flags & 64)) {
          mode = (mode & 4095) | 32768;
        } else {
          mode = 0;
        }
        var node;
        if (typeof path == 'object') {
          node = path;
        } else {
          path = PATH.normalize(path);
          try {
            var lookup = FS.lookupPath(path, {
              follow: !(flags & 131072)
            });
            node = lookup.node;
          } catch (e) {
            // ignore
          }
        }
        // perhaps we need to create the node
        var created = false;
        if ((flags & 64)) {
          if (node) {
            // if O_CREAT and O_EXCL are set, error out if the node already exists
            if ((flags & 128)) {
              throw new FS.ErrnoError(20);
            }
          } else {
            // node doesn't exist, try to create it
            node = FS.mknod(path, mode, 0);
            created = true;
          }
        }
        if (!node) {
          throw new FS.ErrnoError(44);
        }
        // can't truncate a device
        if (FS.isChrdev(node.mode)) {
          flags &= ~512;
        }
        // if asked only for a directory, then this must be one
        if ((flags & 65536) && !FS.isDir(node.mode)) {
          throw new FS.ErrnoError(54);
        }
        // check permissions, if this is not a file we just created now (it is ok to
        // create and write to a file with read-only permissions; it is read-only
        // for later use)
        if (!created) {
          var errCode = FS.mayOpen(node, flags);
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
        }
        // do truncation if necessary
        if ((flags & 512) && !created) {
          FS.truncate(node, 0);
        }
        // we've already handled these, don't pass down to the underlying vfs
        flags &= ~(128 | 512 | 131072);
  
        // register the stream with the filesystem
        var stream = FS.createStream({
          node,
          path: FS.getPath(node),  // we want the absolute path to the node
          flags,
          seekable: true,
          position: 0,
          stream_ops: node.stream_ops,
          // used by the file family libc calls (fopen, fwrite, ferror, etc.)
          ungotten: [],
          error: false
        });
        // call the new stream's open function
        if (stream.stream_ops.open) {
          stream.stream_ops.open(stream);
        }
        if (Module['logReadFiles'] && !(flags & 1)) {
          if (!FS.readFiles) FS.readFiles = {};
          if (!(path in FS.readFiles)) {
            FS.readFiles[path] = 1;
          }
        }
        return stream;
      },
  close(stream) {
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(8);
        }
        if (stream.getdents) stream.getdents = null; // free readdir state
        try {
          if (stream.stream_ops.close) {
            stream.stream_ops.close(stream);
          }
        } catch (e) {
          throw e;
        } finally {
          FS.closeStream(stream.fd);
        }
        stream.fd = null;
      },
  isClosed(stream) {
        return stream.fd === null;
      },
  llseek(stream, offset, whence) {
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(8);
        }
        if (!stream.seekable || !stream.stream_ops.llseek) {
          throw new FS.ErrnoError(70);
        }
        if (whence != 0 && whence != 1 && whence != 2) {
          throw new FS.ErrnoError(28);
        }
        stream.position = stream.stream_ops.llseek(stream, offset, whence);
        stream.ungotten = [];
        return stream.position;
      },
  read(stream, buffer, offset, length, position) {
        if (length < 0 || position < 0) {
          throw new FS.ErrnoError(28);
        }
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(8);
        }
        if ((stream.flags & 2097155) === 1) {
          throw new FS.ErrnoError(8);
        }
        if (FS.isDir(stream.node.mode)) {
          throw new FS.ErrnoError(31);
        }
        if (!stream.stream_ops.read) {
          throw new FS.ErrnoError(28);
        }
        var seeking = typeof position != 'undefined';
        if (!seeking) {
          position = stream.position;
        } else if (!stream.seekable) {
          throw new FS.ErrnoError(70);
        }
        var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
        if (!seeking) stream.position += bytesRead;
        return bytesRead;
      },
  write(stream, buffer, offset, length, position, canOwn) {
        if (length < 0 || position < 0) {
          throw new FS.ErrnoError(28);
        }
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(8);
        }
        if ((stream.flags & 2097155) === 0) {
          throw new FS.ErrnoError(8);
        }
        if (FS.isDir(stream.node.mode)) {
          throw new FS.ErrnoError(31);
        }
        if (!stream.stream_ops.write) {
          throw new FS.ErrnoError(28);
        }
        if (stream.seekable && stream.flags & 1024) {
          // seek to the end before writing in append mode
          FS.llseek(stream, 0, 2);
        }
        var seeking = typeof position != 'undefined';
        if (!seeking) {
          position = stream.position;
        } else if (!stream.seekable) {
          throw new FS.ErrnoError(70);
        }
        var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
        if (!seeking) stream.position += bytesWritten;
        return bytesWritten;
      },
  allocate(stream, offset, length) {
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(8);
        }
        if (offset < 0 || length <= 0) {
          throw new FS.ErrnoError(28);
        }
        if ((stream.flags & 2097155) === 0) {
          throw new FS.ErrnoError(8);
        }
        if (!FS.isFile(stream.node.mode) && !FS.isDir(stream.node.mode)) {
          throw new FS.ErrnoError(43);
        }
        if (!stream.stream_ops.allocate) {
          throw new FS.ErrnoError(138);
        }
        stream.stream_ops.allocate(stream, offset, length);
      },
  mmap(stream, length, position, prot, flags) {
        // User requests writing to file (prot & PROT_WRITE != 0).
        // Checking if we have permissions to write to the file unless
        // MAP_PRIVATE flag is set. According to POSIX spec it is possible
        // to write to file opened in read-only mode with MAP_PRIVATE flag,
        // as all modifications will be visible only in the memory of
        // the current process.
        if ((prot & 2) !== 0
            && (flags & 2) === 0
            && (stream.flags & 2097155) !== 2) {
          throw new FS.ErrnoError(2);
        }
        if ((stream.flags & 2097155) === 1) {
          throw new FS.ErrnoError(2);
        }
        if (!stream.stream_ops.mmap) {
          throw new FS.ErrnoError(43);
        }
        return stream.stream_ops.mmap(stream, length, position, prot, flags);
      },
  msync(stream, buffer, offset, length, mmapFlags) {
        if (!stream.stream_ops.msync) {
          return 0;
        }
        return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags);
      },
  ioctl(stream, cmd, arg) {
        if (!stream.stream_ops.ioctl) {
          throw new FS.ErrnoError(59);
        }
        return stream.stream_ops.ioctl(stream, cmd, arg);
      },
  readFile(path, opts = {}) {
        opts.flags = opts.flags || 0;
        opts.encoding = opts.encoding || 'binary';
        if (opts.encoding !== 'utf8' && opts.encoding !== 'binary') {
          throw new Error(`Invalid encoding type "${opts.encoding}"`);
        }
        var ret;
        var stream = FS.open(path, opts.flags);
        var stat = FS.stat(path);
        var length = stat.size;
        var buf = new Uint8Array(length);
        FS.read(stream, buf, 0, length, 0);
        if (opts.encoding === 'utf8') {
          ret = UTF8ArrayToString(buf, 0);
        } else if (opts.encoding === 'binary') {
          ret = buf;
        }
        FS.close(stream);
        return ret;
      },
  writeFile(path, data, opts = {}) {
        opts.flags = opts.flags || 577;
        var stream = FS.open(path, opts.flags, opts.mode);
        if (typeof data == 'string') {
          var buf = new Uint8Array(lengthBytesUTF8(data)+1);
          var actualNumBytes = stringToUTF8Array(data, buf, 0, buf.length);
          FS.write(stream, buf, 0, actualNumBytes, undefined, opts.canOwn);
        } else if (ArrayBuffer.isView(data)) {
          FS.write(stream, data, 0, data.byteLength, undefined, opts.canOwn);
        } else {
          throw new Error('Unsupported data type');
        }
        FS.close(stream);
      },
  cwd:() => FS.currentPath,
  chdir(path) {
        var lookup = FS.lookupPath(path, { follow: true });
        if (lookup.node === null) {
          throw new FS.ErrnoError(44);
        }
        if (!FS.isDir(lookup.node.mode)) {
          throw new FS.ErrnoError(54);
        }
        var errCode = FS.nodePermissions(lookup.node, 'x');
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        FS.currentPath = lookup.path;
      },
  createDefaultDirectories() {
        FS.mkdir('/tmp');
        FS.mkdir('/home');
        FS.mkdir('/home/web_user');
      },
  createDefaultDevices() {
        // create /dev
        FS.mkdir('/dev');
        // setup /dev/null
        FS.registerDevice(FS.makedev(1, 3), {
          read: () => 0,
          write: (stream, buffer, offset, length, pos) => length,
        });
        FS.mkdev('/dev/null', FS.makedev(1, 3));
        // setup /dev/tty and /dev/tty1
        // stderr needs to print output using err() rather than out()
        // so we register a second tty just for it.
        TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
        TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
        FS.mkdev('/dev/tty', FS.makedev(5, 0));
        FS.mkdev('/dev/tty1', FS.makedev(6, 0));
        // setup /dev/[u]random
        // use a buffer to avoid overhead of individual crypto calls per byte
        var randomBuffer = new Uint8Array(1024), randomLeft = 0;
        var randomByte = () => {
          if (randomLeft === 0) {
            randomLeft = randomFill(randomBuffer).byteLength;
          }
          return randomBuffer[--randomLeft];
        };
        FS.createDevice('/dev', 'random', randomByte);
        FS.createDevice('/dev', 'urandom', randomByte);
        // we're not going to emulate the actual shm device,
        // just create the tmp dirs that reside in it commonly
        FS.mkdir('/dev/shm');
        FS.mkdir('/dev/shm/tmp');
      },
  createSpecialDirectories() {
        // create /proc/self/fd which allows /proc/self/fd/6 => readlink gives the
        // name of the stream for fd 6 (see test_unistd_ttyname)
        FS.mkdir('/proc');
        var proc_self = FS.mkdir('/proc/self');
        FS.mkdir('/proc/self/fd');
        FS.mount({
          mount() {
            var node = FS.createNode(proc_self, 'fd', 16384 | 511 /* 0777 */, 73);
            node.node_ops = {
              lookup(parent, name) {
                var fd = +name;
                var stream = FS.getStreamChecked(fd);
                var ret = {
                  parent: null,
                  mount: { mountpoint: 'fake' },
                  node_ops: { readlink: () => stream.path },
                };
                ret.parent = ret; // make it look like a simple root node
                return ret;
              }
            };
            return node;
          }
        }, {}, '/proc/self/fd');
      },
  createStandardStreams() {
        // TODO deprecate the old functionality of a single
        // input / output callback and that utilizes FS.createDevice
        // and instead require a unique set of stream ops
  
        // by default, we symlink the standard streams to the
        // default tty devices. however, if the standard streams
        // have been overwritten we create a unique device for
        // them instead.
        if (Module['stdin']) {
          FS.createDevice('/dev', 'stdin', Module['stdin']);
        } else {
          FS.symlink('/dev/tty', '/dev/stdin');
        }
        if (Module['stdout']) {
          FS.createDevice('/dev', 'stdout', null, Module['stdout']);
        } else {
          FS.symlink('/dev/tty', '/dev/stdout');
        }
        if (Module['stderr']) {
          FS.createDevice('/dev', 'stderr', null, Module['stderr']);
        } else {
          FS.symlink('/dev/tty1', '/dev/stderr');
        }
  
        // open default streams for the stdin, stdout and stderr devices
        var stdin = FS.open('/dev/stdin', 0);
        var stdout = FS.open('/dev/stdout', 1);
        var stderr = FS.open('/dev/stderr', 1);
      },
  staticInit() {
        // Some errors may happen quite a bit, to avoid overhead we reuse them (and suffer a lack of stack info)
        [44].forEach((code) => {
          FS.genericErrors[code] = new FS.ErrnoError(code);
          FS.genericErrors[code].stack = '<generic error, no stack>';
        });
  
        FS.nameTable = new Array(4096);
  
        FS.mount(MEMFS, {}, '/');
  
        FS.createDefaultDirectories();
        FS.createDefaultDevices();
        FS.createSpecialDirectories();
  
        FS.filesystems = {
          'MEMFS': MEMFS,
          'IDBFS': IDBFS,
        };
      },
  init(input, output, error) {
        FS.init.initialized = true;
  
        // Allow Module.stdin etc. to provide defaults, if none explicitly passed to us here
        Module['stdin'] = input || Module['stdin'];
        Module['stdout'] = output || Module['stdout'];
        Module['stderr'] = error || Module['stderr'];
  
        FS.createStandardStreams();
      },
  quit() {
        FS.init.initialized = false;
        // force-flush all streams, so we get musl std streams printed out
        _fflush(0);
        // close all of our streams
        for (var i = 0; i < FS.streams.length; i++) {
          var stream = FS.streams[i];
          if (!stream) {
            continue;
          }
          FS.close(stream);
        }
      },
  findObject(path, dontResolveLastLink) {
        var ret = FS.analyzePath(path, dontResolveLastLink);
        if (!ret.exists) {
          return null;
        }
        return ret.object;
      },
  analyzePath(path, dontResolveLastLink) {
        // operate from within the context of the symlink's target
        try {
          var lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
          path = lookup.path;
        } catch (e) {
        }
        var ret = {
          isRoot: false, exists: false, error: 0, name: null, path: null, object: null,
          parentExists: false, parentPath: null, parentObject: null
        };
        try {
          var lookup = FS.lookupPath(path, { parent: true });
          ret.parentExists = true;
          ret.parentPath = lookup.path;
          ret.parentObject = lookup.node;
          ret.name = PATH.basename(path);
          lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
          ret.exists = true;
          ret.path = lookup.path;
          ret.object = lookup.node;
          ret.name = lookup.node.name;
          ret.isRoot = lookup.path === '/';
        } catch (e) {
          ret.error = e.errno;
        };
        return ret;
      },
  createPath(parent, path, canRead, canWrite) {
        parent = typeof parent == 'string' ? parent : FS.getPath(parent);
        var parts = path.split('/').reverse();
        while (parts.length) {
          var part = parts.pop();
          if (!part) continue;
          var current = PATH.join2(parent, part);
          try {
            FS.mkdir(current);
          } catch (e) {
            // ignore EEXIST
          }
          parent = current;
        }
        return current;
      },
  createFile(parent, name, properties, canRead, canWrite) {
        var path = PATH.join2(typeof parent == 'string' ? parent : FS.getPath(parent), name);
        var mode = FS_getMode(canRead, canWrite);
        return FS.create(path, mode);
      },
  createDataFile(parent, name, data, canRead, canWrite, canOwn) {
        var path = name;
        if (parent) {
          parent = typeof parent == 'string' ? parent : FS.getPath(parent);
          path = name ? PATH.join2(parent, name) : parent;
        }
        var mode = FS_getMode(canRead, canWrite);
        var node = FS.create(path, mode);
        if (data) {
          if (typeof data == 'string') {
            var arr = new Array(data.length);
            for (var i = 0, len = data.length; i < len; ++i) arr[i] = data.charCodeAt(i);
            data = arr;
          }
          // make sure we can write to the file
          FS.chmod(node, mode | 146);
          var stream = FS.open(node, 577);
          FS.write(stream, data, 0, data.length, 0, canOwn);
          FS.close(stream);
          FS.chmod(node, mode);
        }
      },
  createDevice(parent, name, input, output) {
        var path = PATH.join2(typeof parent == 'string' ? parent : FS.getPath(parent), name);
        var mode = FS_getMode(!!input, !!output);
        if (!FS.createDevice.major) FS.createDevice.major = 64;
        var dev = FS.makedev(FS.createDevice.major++, 0);
        // Create a fake device that a set of stream ops to emulate
        // the old behavior.
        FS.registerDevice(dev, {
          open(stream) {
            stream.seekable = false;
          },
          close(stream) {
            // flush any pending line data
            if (output?.buffer?.length) {
              output(10);
            }
          },
          read(stream, buffer, offset, length, pos /* ignored */) {
            var bytesRead = 0;
            for (var i = 0; i < length; i++) {
              var result;
              try {
                result = input();
              } catch (e) {
                throw new FS.ErrnoError(29);
              }
              if (result === undefined && bytesRead === 0) {
                throw new FS.ErrnoError(6);
              }
              if (result === null || result === undefined) break;
              bytesRead++;
              buffer[offset+i] = result;
            }
            if (bytesRead) {
              stream.node.timestamp = Date.now();
            }
            return bytesRead;
          },
          write(stream, buffer, offset, length, pos) {
            for (var i = 0; i < length; i++) {
              try {
                output(buffer[offset+i]);
              } catch (e) {
                throw new FS.ErrnoError(29);
              }
            }
            if (length) {
              stream.node.timestamp = Date.now();
            }
            return i;
          }
        });
        return FS.mkdev(path, mode, dev);
      },
  forceLoadFile(obj) {
        if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
        if (typeof XMLHttpRequest != 'undefined') {
          throw new Error("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
        } else if (read_) {
          // Command-line.
          try {
            // WARNING: Can't read binary files in V8's d8 or tracemonkey's js, as
            //          read() will try to parse UTF8.
            obj.contents = intArrayFromString(read_(obj.url), true);
            obj.usedBytes = obj.contents.length;
          } catch (e) {
            throw new FS.ErrnoError(29);
          }
        } else {
          throw new Error('Cannot load without read() or XMLHttpRequest.');
        }
      },
  createLazyFile(parent, name, url, canRead, canWrite) {
        // Lazy chunked Uint8Array (implements get and length from Uint8Array).
        // Actual getting is abstracted away for eventual reuse.
        class LazyUint8Array {
          constructor() {
            this.lengthKnown = false;
            this.chunks = []; // Loaded chunks. Index is the chunk number
          }
          get(idx) {
            if (idx > this.length-1 || idx < 0) {
              return undefined;
            }
            var chunkOffset = idx % this.chunkSize;
            var chunkNum = (idx / this.chunkSize)|0;
            return this.getter(chunkNum)[chunkOffset];
          }
          setDataGetter(getter) {
            this.getter = getter;
          }
          cacheLength() {
            // Find length
            var xhr = new XMLHttpRequest();
            xhr.open('HEAD', url, false);
            xhr.send(null);
            if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
            var datalength = Number(xhr.getResponseHeader("Content-length"));
            var header;
            var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
            var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
  
            var chunkSize = 1024*1024; // Chunk size in bytes
  
            if (!hasByteServing) chunkSize = datalength;
  
            // Function to get a range from the remote URL.
            var doXHR = (from, to) => {
              if (from > to) throw new Error("invalid range (" + from + ", " + to + ") or no bytes requested!");
              if (to > datalength-1) throw new Error("only " + datalength + " bytes available! programmer error!");
  
              // TODO: Use mozResponseArrayBuffer, responseStream, etc. if available.
              var xhr = new XMLHttpRequest();
              xhr.open('GET', url, false);
              if (datalength !== chunkSize) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);
  
              // Some hints to the browser that we want binary data.
              xhr.responseType = 'arraybuffer';
              if (xhr.overrideMimeType) {
                xhr.overrideMimeType('text/plain; charset=x-user-defined');
              }
  
              xhr.send(null);
              if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
              if (xhr.response !== undefined) {
                return new Uint8Array(/** @type{Array<number>} */(xhr.response || []));
              }
              return intArrayFromString(xhr.responseText || '', true);
            };
            var lazyArray = this;
            lazyArray.setDataGetter((chunkNum) => {
              var start = chunkNum * chunkSize;
              var end = (chunkNum+1) * chunkSize - 1; // including this byte
              end = Math.min(end, datalength-1); // if datalength-1 is selected, this is the last block
              if (typeof lazyArray.chunks[chunkNum] == 'undefined') {
                lazyArray.chunks[chunkNum] = doXHR(start, end);
              }
              if (typeof lazyArray.chunks[chunkNum] == 'undefined') throw new Error('doXHR failed!');
              return lazyArray.chunks[chunkNum];
            });
  
            if (usesGzip || !datalength) {
              // if the server uses gzip or doesn't supply the length, we have to download the whole file to get the (uncompressed) length
              chunkSize = datalength = 1; // this will force getter(0)/doXHR do download the whole file
              datalength = this.getter(0).length;
              chunkSize = datalength;
              out("LazyFiles on gzip forces download of the whole file when length is accessed");
            }
  
            this._length = datalength;
            this._chunkSize = chunkSize;
            this.lengthKnown = true;
          }
          get length() {
            if (!this.lengthKnown) {
              this.cacheLength();
            }
            return this._length;
          }
          get chunkSize() {
            if (!this.lengthKnown) {
              this.cacheLength();
            }
            return this._chunkSize;
          }
        }
  
        if (typeof XMLHttpRequest != 'undefined') {
          if (!ENVIRONMENT_IS_WORKER) throw 'Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc';
          var lazyArray = new LazyUint8Array();
          var properties = { isDevice: false, contents: lazyArray };
        } else {
          var properties = { isDevice: false, url: url };
        }
  
        var node = FS.createFile(parent, name, properties, canRead, canWrite);
        // This is a total hack, but I want to get this lazy file code out of the
        // core of MEMFS. If we want to keep this lazy file concept I feel it should
        // be its own thin LAZYFS proxying calls to MEMFS.
        if (properties.contents) {
          node.contents = properties.contents;
        } else if (properties.url) {
          node.contents = null;
          node.url = properties.url;
        }
        // Add a function that defers querying the file size until it is asked the first time.
        Object.defineProperties(node, {
          usedBytes: {
            get: function() { return this.contents.length; }
          }
        });
        // override each stream op with one that tries to force load the lazy file first
        var stream_ops = {};
        var keys = Object.keys(node.stream_ops);
        keys.forEach((key) => {
          var fn = node.stream_ops[key];
          stream_ops[key] = (...args) => {
            FS.forceLoadFile(node);
            return fn(...args);
          };
        });
        function writeChunks(stream, buffer, offset, length, position) {
          var contents = stream.node.contents;
          if (position >= contents.length)
            return 0;
          var size = Math.min(contents.length - position, length);
          if (contents.slice) { // normal array
            for (var i = 0; i < size; i++) {
              buffer[offset + i] = contents[position + i];
            }
          } else {
            for (var i = 0; i < size; i++) { // LazyUint8Array from sync binary XHR
              buffer[offset + i] = contents.get(position + i);
            }
          }
          return size;
        }
        // use a custom read function
        stream_ops.read = (stream, buffer, offset, length, position) => {
          FS.forceLoadFile(node);
          return writeChunks(stream, buffer, offset, length, position)
        };
        // use a custom mmap function
        stream_ops.mmap = (stream, length, position, prot, flags) => {
          FS.forceLoadFile(node);
          var ptr = mmapAlloc(length);
          if (!ptr) {
            throw new FS.ErrnoError(48);
          }
          writeChunks(stream, HEAP8, ptr, length, position);
          return { ptr, allocated: true };
        };
        node.stream_ops = stream_ops;
        return node;
      },
  };
  
  var SYSCALLS = {
  DEFAULT_POLLMASK:5,
  calculateAt(dirfd, path, allowEmpty) {
        if (PATH.isAbs(path)) {
          return path;
        }
        // relative path
        var dir;
        if (dirfd === -100) {
          dir = FS.cwd();
        } else {
          var dirstream = SYSCALLS.getStreamFromFD(dirfd);
          dir = dirstream.path;
        }
        if (path.length == 0) {
          if (!allowEmpty) {
            throw new FS.ErrnoError(44);;
          }
          return dir;
        }
        return PATH.join2(dir, path);
      },
  doStat(func, path, buf) {
        var stat = func(path);
        HEAP32[((buf)>>2)] = stat.dev;
        HEAP32[(((buf)+(4))>>2)] = stat.mode;
        HEAPU32[(((buf)+(8))>>2)] = stat.nlink;
        HEAP32[(((buf)+(12))>>2)] = stat.uid;
        HEAP32[(((buf)+(16))>>2)] = stat.gid;
        HEAP32[(((buf)+(20))>>2)] = stat.rdev;
        HEAP64[(((buf)+(24))>>3)] = BigInt(stat.size);
        HEAP32[(((buf)+(32))>>2)] = 4096;
        HEAP32[(((buf)+(36))>>2)] = stat.blocks;
        var atime = stat.atime.getTime();
        var mtime = stat.mtime.getTime();
        var ctime = stat.ctime.getTime();
        HEAP64[(((buf)+(40))>>3)] = BigInt(Math.floor(atime / 1000));
        HEAPU32[(((buf)+(48))>>2)] = (atime % 1000) * 1000;
        HEAP64[(((buf)+(56))>>3)] = BigInt(Math.floor(mtime / 1000));
        HEAPU32[(((buf)+(64))>>2)] = (mtime % 1000) * 1000;
        HEAP64[(((buf)+(72))>>3)] = BigInt(Math.floor(ctime / 1000));
        HEAPU32[(((buf)+(80))>>2)] = (ctime % 1000) * 1000;
        HEAP64[(((buf)+(88))>>3)] = BigInt(stat.ino);
        return 0;
      },
  doMsync(addr, stream, len, flags, offset) {
        if (!FS.isFile(stream.node.mode)) {
          throw new FS.ErrnoError(43);
        }
        if (flags & 2) {
          // MAP_PRIVATE calls need not to be synced back to underlying fs
          return 0;
        }
        var buffer = HEAPU8.slice(addr, addr + len);
        FS.msync(stream, buffer, offset, len, flags);
      },
  varargs:undefined,
  get() {
        // the `+` prepended here is necessary to convince the JSCompiler that varargs is indeed a number.
        var ret = HEAP32[((+SYSCALLS.varargs)>>2)];
        SYSCALLS.varargs += 4;
        return ret;
      },
  getp() { return SYSCALLS.get() },
  getStr(ptr) {
        var ret = UTF8ToString(ptr);
        return ret;
      },
  getStreamFromFD(fd) {
        var stream = FS.getStreamChecked(fd);
        return stream;
      },
  };
  
  
  function ___syscall_chdir(path) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(3, 0, 1, path);
  
  try {
  
      path = SYSCALLS.getStr(path);
      FS.chdir(path);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_chmod(path, mode) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(4, 0, 1, path, mode);
  
  try {
  
      path = SYSCALLS.getStr(path);
      FS.chmod(path, mode);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  var SOCKFS = {
  mount(mount) {
        // If Module['websocket'] has already been defined (e.g. for configuring
        // the subprotocol/url) use that, if not initialise it to a new object.
        Module['websocket'] = (Module['websocket'] &&
                               ('object' === typeof Module['websocket'])) ? Module['websocket'] : {};
  
        // Add the Event registration mechanism to the exported websocket configuration
        // object so we can register network callbacks from native JavaScript too.
        // For more documentation see system/include/emscripten/emscripten.h
        Module['websocket']._callbacks = {};
        Module['websocket']['on'] = /** @this{Object} */ function(event, callback) {
          if ('function' === typeof callback) {
            this._callbacks[event] = callback;
          }
          return this;
        };
  
        Module['websocket'].emit = /** @this{Object} */ function(event, param) {
          if ('function' === typeof this._callbacks[event]) {
            this._callbacks[event].call(this, param);
          }
        };
  
        // If debug is enabled register simple default logging callbacks for each Event.
  
        return FS.createNode(null, '/', 16384 | 511 /* 0777 */, 0);
      },
  createSocket(family, type, protocol) {
        type &= ~526336; // Some applications may pass it; it makes no sense for a single process.
        var streaming = type == 1;
        if (streaming && protocol && protocol != 6) {
          throw new FS.ErrnoError(66); // if SOCK_STREAM, must be tcp or 0.
        }
  
        // create our internal socket structure
        var sock = {
          family,
          type,
          protocol,
          server: null,
          error: null, // Used in getsockopt for SOL_SOCKET/SO_ERROR test
          peers: {},
          pending: [],
          recv_queue: [],
          sock_ops: SOCKFS.websocket_sock_ops
        };
  
        // create the filesystem node to store the socket structure
        var name = SOCKFS.nextname();
        var node = FS.createNode(SOCKFS.root, name, 49152, 0);
        node.sock = sock;
  
        // and the wrapping stream that enables library functions such
        // as read and write to indirectly interact with the socket
        var stream = FS.createStream({
          path: name,
          node,
          flags: 2,
          seekable: false,
          stream_ops: SOCKFS.stream_ops
        });
  
        // map the new stream to the socket structure (sockets have a 1:1
        // relationship with a stream)
        sock.stream = stream;
  
        return sock;
      },
  getSocket(fd) {
        var stream = FS.getStream(fd);
        if (!stream || !FS.isSocket(stream.node.mode)) {
          return null;
        }
        return stream.node.sock;
      },
  stream_ops:{
  poll(stream) {
          var sock = stream.node.sock;
          return sock.sock_ops.poll(sock);
        },
  ioctl(stream, request, varargs) {
          var sock = stream.node.sock;
          return sock.sock_ops.ioctl(sock, request, varargs);
        },
  read(stream, buffer, offset, length, position /* ignored */) {
          var sock = stream.node.sock;
          var msg = sock.sock_ops.recvmsg(sock, length);
          if (!msg) {
            // socket is closed
            return 0;
          }
          buffer.set(msg.buffer, offset);
          return msg.buffer.length;
        },
  write(stream, buffer, offset, length, position /* ignored */) {
          var sock = stream.node.sock;
          return sock.sock_ops.sendmsg(sock, buffer, offset, length);
        },
  close(stream) {
          var sock = stream.node.sock;
          sock.sock_ops.close(sock);
        },
  },
  nextname() {
        if (!SOCKFS.nextname.current) {
          SOCKFS.nextname.current = 0;
        }
        return 'socket[' + (SOCKFS.nextname.current++) + ']';
      },
  websocket_sock_ops:{
  createPeer(sock, addr, port) {
          var ws;
  
          if (typeof addr == 'object') {
            ws = addr;
            addr = null;
            port = null;
          }
  
          if (ws) {
            // for sockets that've already connected (e.g. we're the server)
            // we can inspect the _socket property for the address
            if (ws._socket) {
              addr = ws._socket.remoteAddress;
              port = ws._socket.remotePort;
            }
            // if we're just now initializing a connection to the remote,
            // inspect the url property
            else {
              var result = /ws[s]?:\/\/([^:]+):(\d+)/.exec(ws.url);
              if (!result) {
                throw new Error('WebSocket URL must be in the format ws(s)://address:port');
              }
              addr = result[1];
              port = parseInt(result[2], 10);
            }
          } else {
            // create the actual websocket object and connect
            try {
              // runtimeConfig gets set to true if WebSocket runtime configuration is available.
              var runtimeConfig = (Module['websocket'] && ('object' === typeof Module['websocket']));
  
              // The default value is 'ws://' the replace is needed because the compiler replaces '//' comments with '#'
              // comments without checking context, so we'd end up with ws:#, the replace swaps the '#' for '//' again.
              var url = 'ws:#'.replace('#', '//');
  
              if (runtimeConfig) {
                if ('string' === typeof Module['websocket']['url']) {
                  url = Module['websocket']['url']; // Fetch runtime WebSocket URL config.
                }
              }
  
              if (url === 'ws://' || url === 'wss://') { // Is the supplied URL config just a prefix, if so complete it.
                var parts = addr.split('/');
                url = url + parts[0] + ":" + port + "/" + parts.slice(1).join('/');
              }
  
              // Make the WebSocket subprotocol (Sec-WebSocket-Protocol) default to binary if no configuration is set.
              var subProtocols = 'binary'; // The default value is 'binary'
  
              if (runtimeConfig) {
                if ('string' === typeof Module['websocket']['subprotocol']) {
                  subProtocols = Module['websocket']['subprotocol']; // Fetch runtime WebSocket subprotocol config.
                }
              }
  
              // The default WebSocket options
              var opts = undefined;
  
              if (subProtocols !== 'null') {
                // The regex trims the string (removes spaces at the beginning and end, then splits the string by
                // <any space>,<any space> into an Array. Whitespace removal is important for Websockify and ws.
                subProtocols = subProtocols.replace(/^ +| +$/g,"").split(/ *, */);
  
                opts = subProtocols;
              }
  
              // some webservers (azure) does not support subprotocol header
              if (runtimeConfig && null === Module['websocket']['subprotocol']) {
                subProtocols = 'null';
                opts = undefined;
              }
  
              // If node we use the ws library.
              var WebSocketConstructor;
              if (ENVIRONMENT_IS_NODE) {
                WebSocketConstructor = /** @type{(typeof WebSocket)} */(require('ws'));
              } else
              {
                WebSocketConstructor = WebSocket;
              }
              ws = new WebSocketConstructor(url, opts);
              ws.binaryType = 'arraybuffer';
            } catch (e) {
              throw new FS.ErrnoError(23);
            }
          }
  
          var peer = {
            addr,
            port,
            socket: ws,
            dgram_send_queue: []
          };
  
          SOCKFS.websocket_sock_ops.addPeer(sock, peer);
          SOCKFS.websocket_sock_ops.handlePeerEvents(sock, peer);
  
          // if this is a bound dgram socket, send the port number first to allow
          // us to override the ephemeral port reported to us by remotePort on the
          // remote end.
          if (sock.type === 2 && typeof sock.sport != 'undefined') {
            peer.dgram_send_queue.push(new Uint8Array([
                255, 255, 255, 255,
                'p'.charCodeAt(0), 'o'.charCodeAt(0), 'r'.charCodeAt(0), 't'.charCodeAt(0),
                ((sock.sport & 0xff00) >> 8) , (sock.sport & 0xff)
            ]));
          }
  
          return peer;
        },
  getPeer(sock, addr, port) {
          return sock.peers[addr + ':' + port];
        },
  addPeer(sock, peer) {
          sock.peers[peer.addr + ':' + peer.port] = peer;
        },
  removePeer(sock, peer) {
          delete sock.peers[peer.addr + ':' + peer.port];
        },
  handlePeerEvents(sock, peer) {
          var first = true;
  
          var handleOpen = function () {
  
            Module['websocket'].emit('open', sock.stream.fd);
  
            try {
              var queued = peer.dgram_send_queue.shift();
              while (queued) {
                peer.socket.send(queued);
                queued = peer.dgram_send_queue.shift();
              }
            } catch (e) {
              // not much we can do here in the way of proper error handling as we've already
              // lied and said this data was sent. shut it down.
              peer.socket.close();
            }
          };
  
          function handleMessage(data) {
            if (typeof data == 'string') {
              var encoder = new TextEncoder(); // should be utf-8
              data = encoder.encode(data); // make a typed array from the string
            } else {
              assert(data.byteLength !== undefined); // must receive an ArrayBuffer
              if (data.byteLength == 0) {
                // An empty ArrayBuffer will emit a pseudo disconnect event
                // as recv/recvmsg will return zero which indicates that a socket
                // has performed a shutdown although the connection has not been disconnected yet.
                return;
              }
              data = new Uint8Array(data); // make a typed array view on the array buffer
            }
  
            // if this is the port message, override the peer's port with it
            var wasfirst = first;
            first = false;
            if (wasfirst &&
                data.length === 10 &&
                data[0] === 255 && data[1] === 255 && data[2] === 255 && data[3] === 255 &&
                data[4] === 'p'.charCodeAt(0) && data[5] === 'o'.charCodeAt(0) && data[6] === 'r'.charCodeAt(0) && data[7] === 't'.charCodeAt(0)) {
              // update the peer's port and it's key in the peer map
              var newport = ((data[8] << 8) | data[9]);
              SOCKFS.websocket_sock_ops.removePeer(sock, peer);
              peer.port = newport;
              SOCKFS.websocket_sock_ops.addPeer(sock, peer);
              return;
            }
  
            sock.recv_queue.push({ addr: peer.addr, port: peer.port, data: data });
            Module['websocket'].emit('message', sock.stream.fd);
          };
  
          if (ENVIRONMENT_IS_NODE) {
            peer.socket.on('open', handleOpen);
            peer.socket.on('message', function(data, isBinary) {
              if (!isBinary) {
                return;
              }
              handleMessage((new Uint8Array(data)).buffer); // copy from node Buffer -> ArrayBuffer
            });
            peer.socket.on('close', function() {
              Module['websocket'].emit('close', sock.stream.fd);
            });
            peer.socket.on('error', function(error) {
              // Although the ws library may pass errors that may be more descriptive than
              // ECONNREFUSED they are not necessarily the expected error code e.g.
              // ENOTFOUND on getaddrinfo seems to be node.js specific, so using ECONNREFUSED
              // is still probably the most useful thing to do.
              sock.error = 14; // Used in getsockopt for SOL_SOCKET/SO_ERROR test.
              Module['websocket'].emit('error', [sock.stream.fd, sock.error, 'ECONNREFUSED: Connection refused']);
              // don't throw
            });
          } else {
            peer.socket.onopen = handleOpen;
            peer.socket.onclose = function() {
              Module['websocket'].emit('close', sock.stream.fd);
            };
            peer.socket.onmessage = function peer_socket_onmessage(event) {
              handleMessage(event.data);
            };
            peer.socket.onerror = function(error) {
              // The WebSocket spec only allows a 'simple event' to be thrown on error,
              // so we only really know as much as ECONNREFUSED.
              sock.error = 14; // Used in getsockopt for SOL_SOCKET/SO_ERROR test.
              Module['websocket'].emit('error', [sock.stream.fd, sock.error, 'ECONNREFUSED: Connection refused']);
            };
          }
        },
  poll(sock) {
          if (sock.type === 1 && sock.server) {
            // listen sockets should only say they're available for reading
            // if there are pending clients.
            return sock.pending.length ? (64 | 1) : 0;
          }
  
          var mask = 0;
          var dest = sock.type === 1 ?  // we only care about the socket state for connection-based sockets
            SOCKFS.websocket_sock_ops.getPeer(sock, sock.daddr, sock.dport) :
            null;
  
          if (sock.recv_queue.length ||
              !dest ||  // connection-less sockets are always ready to read
              (dest && dest.socket.readyState === dest.socket.CLOSING) ||
              (dest && dest.socket.readyState === dest.socket.CLOSED)) {  // let recv return 0 once closed
            mask |= (64 | 1);
          }
  
          if (!dest ||  // connection-less sockets are always ready to write
              (dest && dest.socket.readyState === dest.socket.OPEN)) {
            mask |= 4;
          }
  
          if ((dest && dest.socket.readyState === dest.socket.CLOSING) ||
              (dest && dest.socket.readyState === dest.socket.CLOSED)) {
            mask |= 16;
          }
  
          return mask;
        },
  ioctl(sock, request, arg) {
          switch (request) {
            case 21531:
              var bytes = 0;
              if (sock.recv_queue.length) {
                bytes = sock.recv_queue[0].data.length;
              }
              HEAP32[((arg)>>2)] = bytes;
              return 0;
            default:
              return 28;
          }
        },
  close(sock) {
          // if we've spawned a listen server, close it
          if (sock.server) {
            try {
              sock.server.close();
            } catch (e) {
            }
            sock.server = null;
          }
          // close any peer connections
          var peers = Object.keys(sock.peers);
          for (var i = 0; i < peers.length; i++) {
            var peer = sock.peers[peers[i]];
            try {
              peer.socket.close();
            } catch (e) {
            }
            SOCKFS.websocket_sock_ops.removePeer(sock, peer);
          }
          return 0;
        },
  bind(sock, addr, port) {
          if (typeof sock.saddr != 'undefined' || typeof sock.sport != 'undefined') {
            throw new FS.ErrnoError(28);  // already bound
          }
          sock.saddr = addr;
          sock.sport = port;
          // in order to emulate dgram sockets, we need to launch a listen server when
          // binding on a connection-less socket
          // note: this is only required on the server side
          if (sock.type === 2) {
            // close the existing server if it exists
            if (sock.server) {
              sock.server.close();
              sock.server = null;
            }
            // swallow error operation not supported error that occurs when binding in the
            // browser where this isn't supported
            try {
              sock.sock_ops.listen(sock, 0);
            } catch (e) {
              if (!(e.name === 'ErrnoError')) throw e;
              if (e.errno !== 138) throw e;
            }
          }
        },
  connect(sock, addr, port) {
          if (sock.server) {
            throw new FS.ErrnoError(138);
          }
  
          // TODO autobind
          // if (!sock.addr && sock.type == 2) {
          // }
  
          // early out if we're already connected / in the middle of connecting
          if (typeof sock.daddr != 'undefined' && typeof sock.dport != 'undefined') {
            var dest = SOCKFS.websocket_sock_ops.getPeer(sock, sock.daddr, sock.dport);
            if (dest) {
              if (dest.socket.readyState === dest.socket.CONNECTING) {
                throw new FS.ErrnoError(7);
              } else {
                throw new FS.ErrnoError(30);
              }
            }
          }
  
          // add the socket to our peer list and set our
          // destination address / port to match
          var peer = SOCKFS.websocket_sock_ops.createPeer(sock, addr, port);
          sock.daddr = peer.addr;
          sock.dport = peer.port;
  
          // always "fail" in non-blocking mode
          throw new FS.ErrnoError(26);
        },
  listen(sock, backlog) {
          if (!ENVIRONMENT_IS_NODE) {
            throw new FS.ErrnoError(138);
          }
          if (sock.server) {
             throw new FS.ErrnoError(28);  // already listening
          }
          var WebSocketServer = require('ws').Server;
          var host = sock.saddr;
          sock.server = new WebSocketServer({
            host,
            port: sock.sport
            // TODO support backlog
          });
          Module['websocket'].emit('listen', sock.stream.fd); // Send Event with listen fd.
  
          sock.server.on('connection', function(ws) {
            if (sock.type === 1) {
              var newsock = SOCKFS.createSocket(sock.family, sock.type, sock.protocol);
  
              // create a peer on the new socket
              var peer = SOCKFS.websocket_sock_ops.createPeer(newsock, ws);
              newsock.daddr = peer.addr;
              newsock.dport = peer.port;
  
              // push to queue for accept to pick up
              sock.pending.push(newsock);
              Module['websocket'].emit('connection', newsock.stream.fd);
            } else {
              // create a peer on the listen socket so calling sendto
              // with the listen socket and an address will resolve
              // to the correct client
              SOCKFS.websocket_sock_ops.createPeer(sock, ws);
              Module['websocket'].emit('connection', sock.stream.fd);
            }
          });
          sock.server.on('close', function() {
            Module['websocket'].emit('close', sock.stream.fd);
            sock.server = null;
          });
          sock.server.on('error', function(error) {
            // Although the ws library may pass errors that may be more descriptive than
            // ECONNREFUSED they are not necessarily the expected error code e.g.
            // ENOTFOUND on getaddrinfo seems to be node.js specific, so using EHOSTUNREACH
            // is still probably the most useful thing to do. This error shouldn't
            // occur in a well written app as errors should get trapped in the compiled
            // app's own getaddrinfo call.
            sock.error = 23; // Used in getsockopt for SOL_SOCKET/SO_ERROR test.
            Module['websocket'].emit('error', [sock.stream.fd, sock.error, 'EHOSTUNREACH: Host is unreachable']);
            // don't throw
          });
        },
  accept(listensock) {
          if (!listensock.server || !listensock.pending.length) {
            throw new FS.ErrnoError(28);
          }
          var newsock = listensock.pending.shift();
          newsock.stream.flags = listensock.stream.flags;
          return newsock;
        },
  getname(sock, peer) {
          var addr, port;
          if (peer) {
            if (sock.daddr === undefined || sock.dport === undefined) {
              throw new FS.ErrnoError(53);
            }
            addr = sock.daddr;
            port = sock.dport;
          } else {
            // TODO saddr and sport will be set for bind()'d UDP sockets, but what
            // should we be returning for TCP sockets that've been connect()'d?
            addr = sock.saddr || 0;
            port = sock.sport || 0;
          }
          return { addr, port };
        },
  sendmsg(sock, buffer, offset, length, addr, port) {
          if (sock.type === 2) {
            // connection-less sockets will honor the message address,
            // and otherwise fall back to the bound destination address
            if (addr === undefined || port === undefined) {
              addr = sock.daddr;
              port = sock.dport;
            }
            // if there was no address to fall back to, error out
            if (addr === undefined || port === undefined) {
              throw new FS.ErrnoError(17);
            }
          } else {
            // connection-based sockets will only use the bound
            addr = sock.daddr;
            port = sock.dport;
          }
  
          // find the peer for the destination address
          var dest = SOCKFS.websocket_sock_ops.getPeer(sock, addr, port);
  
          // early out if not connected with a connection-based socket
          if (sock.type === 1) {
            if (!dest || dest.socket.readyState === dest.socket.CLOSING || dest.socket.readyState === dest.socket.CLOSED) {
              throw new FS.ErrnoError(53);
            } else if (dest.socket.readyState === dest.socket.CONNECTING) {
              throw new FS.ErrnoError(6);
            }
          }
  
          // create a copy of the incoming data to send, as the WebSocket API
          // doesn't work entirely with an ArrayBufferView, it'll just send
          // the entire underlying buffer
          if (ArrayBuffer.isView(buffer)) {
            offset += buffer.byteOffset;
            buffer = buffer.buffer;
          }
  
          var data;
          // WebSockets .send() does not allow passing a SharedArrayBuffer, so clone the portion of the SharedArrayBuffer as a regular
          // ArrayBuffer that we want to send.
          if (buffer instanceof SharedArrayBuffer) {
            data = new Uint8Array(new Uint8Array(buffer.slice(offset, offset + length))).buffer;
          } else {
            data = buffer.slice(offset, offset + length);
          }
  
          // if we're emulating a connection-less dgram socket and don't have
          // a cached connection, queue the buffer to send upon connect and
          // lie, saying the data was sent now.
          if (sock.type === 2) {
            if (!dest || dest.socket.readyState !== dest.socket.OPEN) {
              // if we're not connected, open a new connection
              if (!dest || dest.socket.readyState === dest.socket.CLOSING || dest.socket.readyState === dest.socket.CLOSED) {
                dest = SOCKFS.websocket_sock_ops.createPeer(sock, addr, port);
              }
              dest.dgram_send_queue.push(data);
              return length;
            }
          }
  
          try {
            // send the actual data
            dest.socket.send(data);
            return length;
          } catch (e) {
            throw new FS.ErrnoError(28);
          }
        },
  recvmsg(sock, length) {
          // http://pubs.opengroup.org/onlinepubs/7908799/xns/recvmsg.html
          if (sock.type === 1 && sock.server) {
            // tcp servers should not be recv()'ing on the listen socket
            throw new FS.ErrnoError(53);
          }
  
          var queued = sock.recv_queue.shift();
          if (!queued) {
            if (sock.type === 1) {
              var dest = SOCKFS.websocket_sock_ops.getPeer(sock, sock.daddr, sock.dport);
  
              if (!dest) {
                // if we have a destination address but are not connected, error out
                throw new FS.ErrnoError(53);
              }
              if (dest.socket.readyState === dest.socket.CLOSING || dest.socket.readyState === dest.socket.CLOSED) {
                // return null if the socket has closed
                return null;
              }
              // else, our socket is in a valid state but truly has nothing available
              throw new FS.ErrnoError(6);
            }
            throw new FS.ErrnoError(6);
          }
  
          // queued.data will be an ArrayBuffer if it's unadulterated, but if it's
          // requeued TCP data it'll be an ArrayBufferView
          var queuedLength = queued.data.byteLength || queued.data.length;
          var queuedOffset = queued.data.byteOffset || 0;
          var queuedBuffer = queued.data.buffer || queued.data;
          var bytesRead = Math.min(length, queuedLength);
          var res = {
            buffer: new Uint8Array(queuedBuffer, queuedOffset, bytesRead),
            addr: queued.addr,
            port: queued.port
          };
  
          // push back any unread data for TCP connections
          if (sock.type === 1 && bytesRead < queuedLength) {
            var bytesRemaining = queuedLength - bytesRead;
            queued.data = new Uint8Array(queuedBuffer, queuedOffset + bytesRead, bytesRemaining);
            sock.recv_queue.unshift(queued);
          }
  
          return res;
        },
  },
  };
  
  var getSocketFromFD = (fd) => {
      var socket = SOCKFS.getSocket(fd);
      if (!socket) throw new FS.ErrnoError(8);
      return socket;
    };
  
  var Sockets = {
  BUFFER_SIZE:10240,
  MAX_BUFFER_SIZE:10485760,
  nextFd:1,
  fds:{
  },
  nextport:1,
  maxport:65535,
  peer:null,
  connections:{
  },
  portmap:{
  },
  localAddr:4261412874,
  addrPool:[33554442,50331658,67108874,83886090,100663306,117440522,134217738,150994954,167772170,184549386,201326602,218103818,234881034],
  };
  
  var inetNtop4 = (addr) => {
      return (addr & 0xff) + '.' + ((addr >> 8) & 0xff) + '.' + ((addr >> 16) & 0xff) + '.' + ((addr >> 24) & 0xff)
    };
  
  
  var inetNtop6 = (ints) => {
      //  ref:  http://www.ietf.org/rfc/rfc2373.txt - section 2.5.4
      //  Format for IPv4 compatible and mapped  128-bit IPv6 Addresses
      //  128-bits are split into eight 16-bit words
      //  stored in network byte order (big-endian)
      //  |                80 bits               | 16 |      32 bits        |
      //  +-----------------------------------------------------------------+
      //  |               10 bytes               |  2 |      4 bytes        |
      //  +--------------------------------------+--------------------------+
      //  +               5 words                |  1 |      2 words        |
      //  +--------------------------------------+--------------------------+
      //  |0000..............................0000|0000|    IPv4 ADDRESS     | (compatible)
      //  +--------------------------------------+----+---------------------+
      //  |0000..............................0000|FFFF|    IPv4 ADDRESS     | (mapped)
      //  +--------------------------------------+----+---------------------+
      var str = "";
      var word = 0;
      var longest = 0;
      var lastzero = 0;
      var zstart = 0;
      var len = 0;
      var i = 0;
      var parts = [
        ints[0] & 0xffff,
        (ints[0] >> 16),
        ints[1] & 0xffff,
        (ints[1] >> 16),
        ints[2] & 0xffff,
        (ints[2] >> 16),
        ints[3] & 0xffff,
        (ints[3] >> 16)
      ];
  
      // Handle IPv4-compatible, IPv4-mapped, loopback and any/unspecified addresses
  
      var hasipv4 = true;
      var v4part = "";
      // check if the 10 high-order bytes are all zeros (first 5 words)
      for (i = 0; i < 5; i++) {
        if (parts[i] !== 0) { hasipv4 = false; break; }
      }
  
      if (hasipv4) {
        // low-order 32-bits store an IPv4 address (bytes 13 to 16) (last 2 words)
        v4part = inetNtop4(parts[6] | (parts[7] << 16));
        // IPv4-mapped IPv6 address if 16-bit value (bytes 11 and 12) == 0xFFFF (6th word)
        if (parts[5] === -1) {
          str = "::ffff:";
          str += v4part;
          return str;
        }
        // IPv4-compatible IPv6 address if 16-bit value (bytes 11 and 12) == 0x0000 (6th word)
        if (parts[5] === 0) {
          str = "::";
          //special case IPv6 addresses
          if (v4part === "0.0.0.0") v4part = ""; // any/unspecified address
          if (v4part === "0.0.0.1") v4part = "1";// loopback address
          str += v4part;
          return str;
        }
      }
  
      // Handle all other IPv6 addresses
  
      // first run to find the longest contiguous zero words
      for (word = 0; word < 8; word++) {
        if (parts[word] === 0) {
          if (word - lastzero > 1) {
            len = 0;
          }
          lastzero = word;
          len++;
        }
        if (len > longest) {
          longest = len;
          zstart = word - longest + 1;
        }
      }
  
      for (word = 0; word < 8; word++) {
        if (longest > 1) {
          // compress contiguous zeros - to produce "::"
          if (parts[word] === 0 && word >= zstart && word < (zstart + longest) ) {
            if (word === zstart) {
              str += ":";
              if (zstart === 0) str += ":"; //leading zeros case
            }
            continue;
          }
        }
        // converts 16-bit words from big-endian to little-endian before converting to hex string
        str += Number(_ntohs(parts[word] & 0xffff)).toString(16);
        str += word < 7 ? ":" : "";
      }
      return str;
    };
  
  var readSockaddr = (sa, salen) => {
      // family / port offsets are common to both sockaddr_in and sockaddr_in6
      var family = HEAP16[((sa)>>1)];
      var port = _ntohs(HEAPU16[(((sa)+(2))>>1)]);
      var addr;
  
      switch (family) {
        case 2:
          if (salen !== 16) {
            return { errno: 28 };
          }
          addr = HEAP32[(((sa)+(4))>>2)];
          addr = inetNtop4(addr);
          break;
        case 10:
          if (salen !== 28) {
            return { errno: 28 };
          }
          addr = [
            HEAP32[(((sa)+(8))>>2)],
            HEAP32[(((sa)+(12))>>2)],
            HEAP32[(((sa)+(16))>>2)],
            HEAP32[(((sa)+(20))>>2)]
          ];
          addr = inetNtop6(addr);
          break;
        default:
          return { errno: 5 };
      }
  
      return { family: family, addr: addr, port: port };
    };
  
  
  var inetPton4 = (str) => {
      var b = str.split('.');
      for (var i = 0; i < 4; i++) {
        var tmp = Number(b[i]);
        if (isNaN(tmp)) return null;
        b[i] = tmp;
      }
      return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    };
  
  
  /** @suppress {checkTypes} */
  var jstoi_q = (str) => parseInt(str);
  var inetPton6 = (str) => {
      var words;
      var w, offset, z, i;
      /* http://home.deds.nl/~aeron/regex/ */
      var valid6regx = /^((?=.*::)(?!.*::.+::)(::)?([\dA-F]{1,4}:(:|\b)|){5}|([\dA-F]{1,4}:){6})((([\dA-F]{1,4}((?!\3)::|:\b|$))|(?!\2\3)){2}|(((2[0-4]|1\d|[1-9])?\d|25[0-5])\.?\b){4})$/i
      var parts = [];
      if (!valid6regx.test(str)) {
        return null;
      }
      if (str === "::") {
        return [0, 0, 0, 0, 0, 0, 0, 0];
      }
      // Z placeholder to keep track of zeros when splitting the string on ":"
      if (str.startsWith("::")) {
        str = str.replace("::", "Z:"); // leading zeros case
      } else {
        str = str.replace("::", ":Z:");
      }
  
      if (str.indexOf(".") > 0) {
        // parse IPv4 embedded stress
        str = str.replace(new RegExp('[.]', 'g'), ":");
        words = str.split(":");
        words[words.length-4] = jstoi_q(words[words.length-4]) + jstoi_q(words[words.length-3])*256;
        words[words.length-3] = jstoi_q(words[words.length-2]) + jstoi_q(words[words.length-1])*256;
        words = words.slice(0, words.length-2);
      } else {
        words = str.split(":");
      }
  
      offset = 0; z = 0;
      for (w=0; w < words.length; w++) {
        if (typeof words[w] == 'string') {
          if (words[w] === 'Z') {
            // compressed zeros - write appropriate number of zero words
            for (z = 0; z < (8 - words.length+1); z++) {
              parts[w+z] = 0;
            }
            offset = z-1;
          } else {
            // parse hex to field to 16-bit value and write it in network byte-order
            parts[w+offset] = _htons(parseInt(words[w],16));
          }
        } else {
          // parsed IPv4 words
          parts[w+offset] = words[w];
        }
      }
      return [
        (parts[1] << 16) | parts[0],
        (parts[3] << 16) | parts[2],
        (parts[5] << 16) | parts[4],
        (parts[7] << 16) | parts[6]
      ];
    };
  var DNS = {
  address_map:{
  id:1,
  addrs:{
  },
  names:{
  },
  },
  lookup_name(name) {
        // If the name is already a valid ipv4 / ipv6 address, don't generate a fake one.
        var res = inetPton4(name);
        if (res !== null) {
          return name;
        }
        res = inetPton6(name);
        if (res !== null) {
          return name;
        }
  
        // See if this name is already mapped.
        var addr;
  
        if (DNS.address_map.addrs[name]) {
          addr = DNS.address_map.addrs[name];
        } else {
          var id = DNS.address_map.id++;
          assert(id < 65535, 'exceeded max address mappings of 65535');
  
          addr = '172.29.' + (id & 0xff) + '.' + (id & 0xff00);
  
          DNS.address_map.names[addr] = name;
          DNS.address_map.addrs[name] = addr;
        }
  
        return addr;
      },
  lookup_addr(addr) {
        if (DNS.address_map.names[addr]) {
          return DNS.address_map.names[addr];
        }
  
        return null;
      },
  };
  /** @param {boolean=} allowNull */
  var getSocketAddress = (addrp, addrlen, allowNull) => {
      if (allowNull && addrp === 0) return null;
      var info = readSockaddr(addrp, addrlen);
      if (info.errno) throw new FS.ErrnoError(info.errno);
      info.addr = DNS.lookup_addr(info.addr) || info.addr;
      return info;
    };
  
  
  function ___syscall_connect(fd, addr, addrlen, d1, d2, d3) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(5, 0, 1, fd, addr, addrlen, d1, d2, d3);
  
  try {
  
      var sock = getSocketFromFD(fd);
      var info = getSocketAddress(addr, addrlen);
      sock.sock_ops.connect(sock, info.addr, info.port);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_faccessat(dirfd, path, amode, flags) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(6, 0, 1, dirfd, path, amode, flags);
  
  try {
  
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path);
      if (amode & ~7) {
        // need a valid mode
        return -28;
      }
      var lookup = FS.lookupPath(path, { follow: true });
      var node = lookup.node;
      if (!node) {
        return -44;
      }
      var perms = '';
      if (amode & 4) perms += 'r';
      if (amode & 2) perms += 'w';
      if (amode & 1) perms += 'x';
      if (perms /* otherwise, they've just passed F_OK */ && FS.nodePermissions(node, perms)) {
        return -2;
      }
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  function ___syscall_fadvise64(fd, offset, len, advice) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(7, 0, 0, fd, offset, len, advice);
  
      return 0; // your advice is important to us (but we can't use it)
    
  }
  

  
  function ___syscall_fchmod(fd, mode) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(8, 0, 1, fd, mode);
  
  try {
  
      FS.fchmod(fd, mode);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_fcntl64(fd, cmd, varargs) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(9, 0, 1, fd, cmd, varargs);
  
  SYSCALLS.varargs = varargs;
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      switch (cmd) {
        case 0: {
          var arg = SYSCALLS.get();
          if (arg < 0) {
            return -28;
          }
          while (FS.streams[arg]) {
            arg++;
          }
          var newStream;
          newStream = FS.dupStream(stream, arg);
          return newStream.fd;
        }
        case 1:
        case 2:
          return 0;  // FD_CLOEXEC makes no sense for a single process.
        case 3:
          return stream.flags;
        case 4: {
          var arg = SYSCALLS.get();
          stream.flags |= arg;
          return 0;
        }
        case 12: {
          var arg = SYSCALLS.getp();
          var offset = 0;
          // We're always unlocked.
          HEAP16[(((arg)+(offset))>>1)] = 2;
          return 0;
        }
        case 13:
        case 14:
          return 0; // Pretend that the locking is successful.
      }
      return -28;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_fdatasync(fd) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(10, 0, 1, fd);
  
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      return 0; // we can't do anything synchronously; the in-memory FS is already synced to
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_fstat64(fd, buf) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(11, 0, 1, fd, buf);
  
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      return SYSCALLS.doStat(FS.stat, stream.path, buf);
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_statfs64(path, size, buf) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(13, 0, 1, path, size, buf);
  
  try {
  
      path = SYSCALLS.getStr(path);
      // NOTE: None of the constants here are true. We're just returning safe and
      //       sane values.
      HEAP32[(((buf)+(4))>>2)] = 4096;
      HEAP32[(((buf)+(40))>>2)] = 4096;
      HEAP32[(((buf)+(8))>>2)] = 1000000;
      HEAP32[(((buf)+(12))>>2)] = 500000;
      HEAP32[(((buf)+(16))>>2)] = 500000;
      HEAP32[(((buf)+(20))>>2)] = FS.nextInode;
      HEAP32[(((buf)+(24))>>2)] = 1000000;
      HEAP32[(((buf)+(28))>>2)] = 42;
      HEAP32[(((buf)+(44))>>2)] = 2;  // ST_NOSUID
      HEAP32[(((buf)+(36))>>2)] = 255;
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  
  
  
  
  function ___syscall_fstatfs64(fd, size, buf) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(12, 0, 1, fd, size, buf);
  
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      return ___syscall_statfs64(0, size, buf);
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_ftruncate64(fd, length) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(14, 0, 1, fd, length);
  
    length = bigintToI53Checked(length);
  
    
  try {
  
      if (isNaN(length)) return 61;
      FS.ftruncate(fd, length);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  ;
  
  }
  

  
  var stringToUTF8 = (str, outPtr, maxBytesToWrite) => {
      return stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
    };
  
  
  function ___syscall_getcwd(buf, size) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(15, 0, 1, buf, size);
  
  try {
  
      if (size === 0) return -28;
      var cwd = FS.cwd();
      var cwdLengthInBytes = lengthBytesUTF8(cwd) + 1;
      if (size < cwdLengthInBytes) return -68;
      stringToUTF8(cwd, buf, size);
      return cwdLengthInBytes;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  
  function ___syscall_getdents64(fd, dirp, count) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(16, 0, 1, fd, dirp, count);
  
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd)
      stream.getdents ||= FS.readdir(stream.path);
  
      var struct_size = 280;
      var pos = 0;
      var off = FS.llseek(stream, 0, 1);
  
      var idx = Math.floor(off / struct_size);
  
      while (idx < stream.getdents.length && pos + struct_size <= count) {
        var id;
        var type;
        var name = stream.getdents[idx];
        if (name === '.') {
          id = stream.node.id;
          type = 4; // DT_DIR
        }
        else if (name === '..') {
          var lookup = FS.lookupPath(stream.path, { parent: true });
          id = lookup.node.id;
          type = 4; // DT_DIR
        }
        else {
          var child = FS.lookupNode(stream.node, name);
          id = child.id;
          type = FS.isChrdev(child.mode) ? 2 :  // DT_CHR, character device.
                 FS.isDir(child.mode) ? 4 :     // DT_DIR, directory.
                 FS.isLink(child.mode) ? 10 :   // DT_LNK, symbolic link.
                 8;                             // DT_REG, regular file.
        }
        HEAP64[((dirp + pos)>>3)] = BigInt(id);
        HEAP64[(((dirp + pos)+(8))>>3)] = BigInt((idx + 1) * struct_size);
        HEAP16[(((dirp + pos)+(16))>>1)] = 280;
        HEAP8[(dirp + pos)+(18)] = type;
        stringToUTF8(name, dirp + pos + 19, 256);
        pos += struct_size;
        idx += 1;
      }
      FS.llseek(stream, idx * struct_size, 0);
      return pos;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_ioctl(fd, op, varargs) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(17, 0, 1, fd, op, varargs);
  
  SYSCALLS.varargs = varargs;
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      switch (op) {
        case 21509: {
          if (!stream.tty) return -59;
          return 0;
        }
        case 21505: {
          if (!stream.tty) return -59;
          if (stream.tty.ops.ioctl_tcgets) {
            var termios = stream.tty.ops.ioctl_tcgets(stream);
            var argp = SYSCALLS.getp();
            HEAP32[((argp)>>2)] = termios.c_iflag || 0;
            HEAP32[(((argp)+(4))>>2)] = termios.c_oflag || 0;
            HEAP32[(((argp)+(8))>>2)] = termios.c_cflag || 0;
            HEAP32[(((argp)+(12))>>2)] = termios.c_lflag || 0;
            for (var i = 0; i < 32; i++) {
              HEAP8[(argp + i)+(17)] = termios.c_cc[i] || 0;
            }
            return 0;
          }
          return 0;
        }
        case 21510:
        case 21511:
        case 21512: {
          if (!stream.tty) return -59;
          return 0; // no-op, not actually adjusting terminal settings
        }
        case 21506:
        case 21507:
        case 21508: {
          if (!stream.tty) return -59;
          if (stream.tty.ops.ioctl_tcsets) {
            var argp = SYSCALLS.getp();
            var c_iflag = HEAP32[((argp)>>2)];
            var c_oflag = HEAP32[(((argp)+(4))>>2)];
            var c_cflag = HEAP32[(((argp)+(8))>>2)];
            var c_lflag = HEAP32[(((argp)+(12))>>2)];
            var c_cc = []
            for (var i = 0; i < 32; i++) {
              c_cc.push(HEAP8[(argp + i)+(17)]);
            }
            return stream.tty.ops.ioctl_tcsets(stream.tty, op, { c_iflag, c_oflag, c_cflag, c_lflag, c_cc });
          }
          return 0; // no-op, not actually adjusting terminal settings
        }
        case 21519: {
          if (!stream.tty) return -59;
          var argp = SYSCALLS.getp();
          HEAP32[((argp)>>2)] = 0;
          return 0;
        }
        case 21520: {
          if (!stream.tty) return -59;
          return -28; // not supported
        }
        case 21531: {
          var argp = SYSCALLS.getp();
          return FS.ioctl(stream, op, argp);
        }
        case 21523: {
          // TODO: in theory we should write to the winsize struct that gets
          // passed in, but for now musl doesn't read anything on it
          if (!stream.tty) return -59;
          if (stream.tty.ops.ioctl_tiocgwinsz) {
            var winsize = stream.tty.ops.ioctl_tiocgwinsz(stream.tty);
            var argp = SYSCALLS.getp();
            HEAP16[((argp)>>1)] = winsize[0];
            HEAP16[(((argp)+(2))>>1)] = winsize[1];
          }
          return 0;
        }
        case 21524: {
          // TODO: technically, this ioctl call should change the window size.
          // but, since emscripten doesn't have any concept of a terminal window
          // yet, we'll just silently throw it away as we do TIOCGWINSZ
          if (!stream.tty) return -59;
          return 0;
        }
        case 21515: {
          if (!stream.tty) return -59;
          return 0;
        }
        default: return -28; // not supported
      }
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_lstat64(path, buf) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(18, 0, 1, path, buf);
  
  try {
  
      path = SYSCALLS.getStr(path);
      return SYSCALLS.doStat(FS.lstat, path, buf);
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_mkdirat(dirfd, path, mode) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(19, 0, 1, dirfd, path, mode);
  
  try {
  
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path);
      // remove a trailing slash, if one - /a/b/ has basename of '', but
      // we want to create b in the context of this function
      path = PATH.normalize(path);
      if (path[path.length-1] === '/') path = path.substr(0, path.length-1);
      FS.mkdir(path, mode, 0);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_newfstatat(dirfd, path, buf, flags) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(20, 0, 1, dirfd, path, buf, flags);
  
  try {
  
      path = SYSCALLS.getStr(path);
      var nofollow = flags & 256;
      var allowEmpty = flags & 4096;
      flags = flags & (~6400);
      path = SYSCALLS.calculateAt(dirfd, path, allowEmpty);
      return SYSCALLS.doStat(nofollow ? FS.lstat : FS.stat, path, buf);
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_openat(dirfd, path, flags, varargs) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(21, 0, 1, dirfd, path, flags, varargs);
  
  SYSCALLS.varargs = varargs;
  try {
  
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path);
      var mode = varargs ? SYSCALLS.get() : 0;
      return FS.open(path, flags, mode).fd;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  
  
  function ___syscall_readlinkat(dirfd, path, buf, bufsize) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(22, 0, 1, dirfd, path, buf, bufsize);
  
  try {
  
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path);
      if (bufsize <= 0) return -28;
      var ret = FS.readlink(path);
  
      var len = Math.min(bufsize, lengthBytesUTF8(ret));
      var endChar = HEAP8[buf+len];
      stringToUTF8(ret, buf, bufsize+1);
      // readlink is one of the rare functions that write out a C string, but does never append a null to the output buffer(!)
      // stringToUTF8() always appends a null byte, so restore the character under the null byte after the write.
      HEAP8[buf+len] = endChar;
      return len;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_renameat(olddirfd, oldpath, newdirfd, newpath) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(23, 0, 1, olddirfd, oldpath, newdirfd, newpath);
  
  try {
  
      oldpath = SYSCALLS.getStr(oldpath);
      newpath = SYSCALLS.getStr(newpath);
      oldpath = SYSCALLS.calculateAt(olddirfd, oldpath);
      newpath = SYSCALLS.calculateAt(newdirfd, newpath);
      FS.rename(oldpath, newpath);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_rmdir(path) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(24, 0, 1, path);
  
  try {
  
      path = SYSCALLS.getStr(path);
      FS.rmdir(path);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  
  function ___syscall_sendto(fd, message, length, flags, addr, addr_len) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(25, 0, 1, fd, message, length, flags, addr, addr_len);
  
  try {
  
      var sock = getSocketFromFD(fd);
      var dest = getSocketAddress(addr, addr_len, true);
      if (!dest) {
        // send, no address provided
        return FS.write(sock.stream, HEAP8, message, length);
      }
      // sendto an address
      return sock.sock_ops.sendmsg(sock, HEAP8, message, length, dest.addr, dest.port);
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_socket(domain, type, protocol) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(26, 0, 1, domain, type, protocol);
  
  try {
  
      var sock = SOCKFS.createSocket(domain, type, protocol);
      return sock.stream.fd;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_stat64(path, buf) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(27, 0, 1, path, buf);
  
  try {
  
      path = SYSCALLS.getStr(path);
      return SYSCALLS.doStat(FS.stat, path, buf);
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_symlink(target, linkpath) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(28, 0, 1, target, linkpath);
  
  try {
  
      target = SYSCALLS.getStr(target);
      linkpath = SYSCALLS.getStr(linkpath);
      FS.symlink(target, linkpath);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  
  
  function ___syscall_unlinkat(dirfd, path, flags) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(29, 0, 1, dirfd, path, flags);
  
  try {
  
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path);
      if (flags === 0) {
        FS.unlink(path);
      } else if (flags === 512) {
        FS.rmdir(path);
      } else {
        abort('Invalid flags passed to unlinkat');
      }
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  var readI53FromI64 = (ptr) => {
      return HEAPU32[((ptr)>>2)] + HEAP32[(((ptr)+(4))>>2)] * 4294967296;
    };
  
  
  
  function ___syscall_utimensat(dirfd, path, times, flags) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(30, 0, 1, dirfd, path, times, flags);
  
  try {
  
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path, true);
      if (!times) {
        var atime = Date.now();
        var mtime = atime;
      } else {
        var seconds = readI53FromI64(times);
        var nanoseconds = HEAP32[(((times)+(8))>>2)];
        atime = (seconds*1000) + (nanoseconds/(1000*1000));
        times += 16;
        seconds = readI53FromI64(times);
        nanoseconds = HEAP32[(((times)+(8))>>2)];
        mtime = (seconds*1000) + (nanoseconds/(1000*1000));
      }
      FS.utime(path, atime, mtime);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  
  }
  

  var nowIsMonotonic = 1;
  var __emscripten_get_now_is_monotonic = () => nowIsMonotonic;

  
  
  
  
  var maybeExit = () => {
      if (runtimeExited) {
        return;
      }
      if (!keepRuntimeAlive()) {
        try {
          if (ENVIRONMENT_IS_PTHREAD) __emscripten_thread_exit(EXITSTATUS);
          else
          _exit(EXITSTATUS);
        } catch (e) {
          handleException(e);
        }
      }
    };
  var callUserCallback = (func) => {
      if (runtimeExited || ABORT) {
        return;
      }
      try {
        func();
        maybeExit();
      } catch (e) {
        handleException(e);
      }
    };
  
  
  
  var __emscripten_thread_mailbox_await = (pthread_ptr) => {
      if (typeof Atomics.waitAsync === 'function') {
        // Wait on the pthread's initial self-pointer field because it is easy and
        // safe to access from sending threads that need to notify the waiting
        // thread.
        // TODO: How to make this work with wasm64?
        var wait = Atomics.waitAsync(HEAP32, ((pthread_ptr)>>2), pthread_ptr);
        wait.value.then(checkMailbox);
        var waitingAsync = pthread_ptr + 128;
        Atomics.store(HEAP32, ((waitingAsync)>>2), 1);
      }
      // If `Atomics.waitAsync` is not implemented, then we will always fall back
      // to postMessage and there is no need to do anything here.
    };
  Module['__emscripten_thread_mailbox_await'] = __emscripten_thread_mailbox_await;
  
  var checkMailbox = () => {
      // Only check the mailbox if we have a live pthread runtime. We implement
      // pthread_self to return 0 if there is no live runtime.
      var pthread_ptr = _pthread_self();
      if (pthread_ptr) {
        // If we are using Atomics.waitAsync as our notification mechanism, wait
        // for a notification before processing the mailbox to avoid missing any
        // work that could otherwise arrive after we've finished processing the
        // mailbox and before we're ready for the next notification.
        __emscripten_thread_mailbox_await(pthread_ptr);
        callUserCallback(__emscripten_check_mailbox);
      }
    };
  Module['checkMailbox'] = checkMailbox;
  
  var __emscripten_notify_mailbox_postmessage = (targetThreadId, currThreadId, mainThreadId) => {
      if (targetThreadId == currThreadId) {
        setTimeout(checkMailbox);
      } else if (ENVIRONMENT_IS_PTHREAD) {
        postMessage({'targetThread' : targetThreadId, 'cmd' : 'checkMailbox'});
      } else {
        var worker = PThread.pthreads[targetThreadId];
        if (!worker) {
          return;
        }
        worker.postMessage({'cmd' : 'checkMailbox'});
      }
    };

  
  var proxiedJSCallArgs = [];
  
  var __emscripten_receive_on_main_thread_js = (funcIndex, emAsmAddr, callingThread, numCallArgs, args) => {
      // Sometimes we need to backproxy events to the calling thread (e.g.
      // HTML5 DOM events handlers such as
      // emscripten_set_mousemove_callback()), so keep track in a globally
      // accessible variable about the thread that initiated the proxying.
      numCallArgs /= 2;
      proxiedJSCallArgs.length = numCallArgs;
      var b = ((args)>>3);
      for (var i = 0; i < numCallArgs; i++) {
        if (HEAP64[b + 2*i]) {
          // It's a BigInt.
          proxiedJSCallArgs[i] = HEAP64[b + 2*i + 1];
        } else {
          // It's a Number.
          proxiedJSCallArgs[i] = HEAPF64[b + 2*i + 1];
        }
      }
      // Proxied JS library funcs use funcIndex and EM_ASM functions use emAsmAddr
      var func = emAsmAddr ? ASM_CONSTS[emAsmAddr] : proxiedFunctionTable[funcIndex];
      PThread.currentProxiedOperationCallerThread = callingThread;
      var rtn = func(...proxiedJSCallArgs);
      PThread.currentProxiedOperationCallerThread = 0;
      return rtn;
    };

  
  function __emscripten_runtime_keepalive_clear() {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(31, 0, 1);
  
      noExitRuntime = false;
      runtimeKeepaliveCounter = 0;
    
  }
  

  
  var JSEvents = {
  removeAllEventListeners() {
        while (JSEvents.eventHandlers.length) {
          JSEvents._removeHandler(JSEvents.eventHandlers.length - 1);
        }
        JSEvents.deferredCalls = [];
      },
  registerRemoveEventListeners() {
        if (!JSEvents.removeEventListenersRegistered) {
          __ATEXIT__.push(JSEvents.removeAllEventListeners);
          JSEvents.removeEventListenersRegistered = true;
        }
      },
  inEventHandler:0,
  deferredCalls:[],
  deferCall(targetFunction, precedence, argsList) {
        function arraysHaveEqualContent(arrA, arrB) {
          if (arrA.length != arrB.length) return false;
  
          for (var i in arrA) {
            if (arrA[i] != arrB[i]) return false;
          }
          return true;
        }
        // Test if the given call was already queued, and if so, don't add it again.
        for (var i in JSEvents.deferredCalls) {
          var call = JSEvents.deferredCalls[i];
          if (call.targetFunction == targetFunction && arraysHaveEqualContent(call.argsList, argsList)) {
            return;
          }
        }
        JSEvents.deferredCalls.push({
          targetFunction,
          precedence,
          argsList
        });
  
        JSEvents.deferredCalls.sort((x,y) => x.precedence < y.precedence);
      },
  removeDeferredCalls(targetFunction) {
        for (var i = 0; i < JSEvents.deferredCalls.length; ++i) {
          if (JSEvents.deferredCalls[i].targetFunction == targetFunction) {
            JSEvents.deferredCalls.splice(i, 1);
            --i;
          }
        }
      },
  canPerformEventHandlerRequests() {
        if (navigator.userActivation) {
          // Verify against transient activation status from UserActivation API
          // whether it is possible to perform a request here without needing to defer. See
          // https://developer.mozilla.org/en-US/docs/Web/Security/User_activation#transient_activation
          // and https://caniuse.com/mdn-api_useractivation
          // At the time of writing, Firefox does not support this API: https://bugzilla.mozilla.org/show_bug.cgi?id=1791079
          return navigator.userActivation.isActive;
        }
  
        return JSEvents.inEventHandler && JSEvents.currentEventHandler.allowsDeferredCalls;
      },
  runDeferredCalls() {
        if (!JSEvents.canPerformEventHandlerRequests()) {
          return;
        }
        for (var i = 0; i < JSEvents.deferredCalls.length; ++i) {
          var call = JSEvents.deferredCalls[i];
          JSEvents.deferredCalls.splice(i, 1);
          --i;
          call.targetFunction(...call.argsList);
        }
      },
  eventHandlers:[],
  removeAllHandlersOnTarget:(target, eventTypeString) => {
        for (var i = 0; i < JSEvents.eventHandlers.length; ++i) {
          if (JSEvents.eventHandlers[i].target == target &&
            (!eventTypeString || eventTypeString == JSEvents.eventHandlers[i].eventTypeString)) {
             JSEvents._removeHandler(i--);
           }
        }
      },
  _removeHandler(i) {
        var h = JSEvents.eventHandlers[i];
        h.target.removeEventListener(h.eventTypeString, h.eventListenerFunc, h.useCapture);
        JSEvents.eventHandlers.splice(i, 1);
      },
  registerOrRemoveHandler(eventHandler) {
        if (!eventHandler.target) {
          return -4;
        }
        if (eventHandler.callbackfunc) {
          eventHandler.eventListenerFunc = function(event) {
            // Increment nesting count for the event handler.
            ++JSEvents.inEventHandler;
            JSEvents.currentEventHandler = eventHandler;
            // Process any old deferred calls the user has placed.
            JSEvents.runDeferredCalls();
            // Process the actual event, calls back to user C code handler.
            eventHandler.handlerFunc(event);
            // Process any new deferred calls that were placed right now from this event handler.
            JSEvents.runDeferredCalls();
            // Out of event handler - restore nesting count.
            --JSEvents.inEventHandler;
          };
  
          eventHandler.target.addEventListener(eventHandler.eventTypeString,
                                               eventHandler.eventListenerFunc,
                                               eventHandler.useCapture);
          JSEvents.eventHandlers.push(eventHandler);
          JSEvents.registerRemoveEventListeners();
        } else {
          for (var i = 0; i < JSEvents.eventHandlers.length; ++i) {
            if (JSEvents.eventHandlers[i].target == eventHandler.target
             && JSEvents.eventHandlers[i].eventTypeString == eventHandler.eventTypeString) {
               JSEvents._removeHandler(i--);
             }
          }
        }
        return 0;
      },
  getTargetThreadForEventCallback(targetThread) {
        switch (targetThread) {
          case 1:
            // The event callback for the current event should be called on the
            // main browser thread. (0 == don't proxy)
            return 0;
          case 2:
            // The event callback for the current event should be backproxied to
            // the thread that is registering the event.
            // This can be 0 in the case that the caller uses
            // EM_CALLBACK_THREAD_CONTEXT_CALLING_THREAD but on the main thread
            // itself.
            return PThread.currentProxiedOperationCallerThread;
          default:
            // The event callback for the current event should be proxied to the
            // given specific thread.
            return targetThread;
        }
      },
  getNodeNameForTarget(target) {
        if (!target) return '';
        if (target == window) return '#window';
        if (target == screen) return '#screen';
        return target?.nodeName || '';
      },
  fullscreenEnabled() {
        return document.fullscreenEnabled
        // Safari 13.0.3 on macOS Catalina 10.15.1 still ships with prefixed webkitFullscreenEnabled.
        // TODO: If Safari at some point ships with unprefixed version, update the version check above.
        || document.webkitFullscreenEnabled
         ;
      },
  };
  
  
  
  
  var stringToNewUTF8 = (str) => {
      var size = lengthBytesUTF8(str) + 1;
      var ret = _malloc(size);
      if (ret) stringToUTF8(str, ret, size);
      return ret;
    };
  
  
  
  var setOffscreenCanvasSizeOnTargetThread = (targetThread, targetCanvas, width, height) => {
      targetCanvas = targetCanvas ? UTF8ToString(targetCanvas) : '';
      var targetCanvasPtr = 0;
      if (targetCanvas) {
        targetCanvasPtr = stringToNewUTF8(targetCanvas);
      }
      __emscripten_set_offscreencanvas_size_on_thread(targetThread, targetCanvasPtr, width, height);
    };
  
  
  
  var webgl_enable_WEBGL_draw_instanced_base_vertex_base_instance = (ctx) =>
      // Closure is expected to be allowed to minify the '.dibvbi' property, so not accessing it quoted.
      !!(ctx.dibvbi = ctx.getExtension('WEBGL_draw_instanced_base_vertex_base_instance'));
  
  var webgl_enable_WEBGL_multi_draw_instanced_base_vertex_base_instance = (ctx) => {
      // Closure is expected to be allowed to minify the '.mdibvbi' property, so not accessing it quoted.
      return !!(ctx.mdibvbi = ctx.getExtension('WEBGL_multi_draw_instanced_base_vertex_base_instance'));
    };
  
  var webgl_enable_WEBGL_multi_draw = (ctx) => {
      // Closure is expected to be allowed to minify the '.multiDrawWebgl' property, so not accessing it quoted.
      return !!(ctx.multiDrawWebgl = ctx.getExtension('WEBGL_multi_draw'));
    };
  
  var getEmscriptenSupportedExtensions = (ctx) => {
      // Restrict the list of advertised extensions to those that we actually
      // support.
      var supportedExtensions = [
        // WebGL 2 extensions
        'EXT_color_buffer_float',
        'EXT_conservative_depth',
        'EXT_disjoint_timer_query_webgl2',
        'EXT_texture_norm16',
        'NV_shader_noperspective_interpolation',
        'WEBGL_clip_cull_distance',
        // WebGL 1 and WebGL 2 extensions
        'EXT_color_buffer_half_float',
        'EXT_depth_clamp',
        'EXT_float_blend',
        'EXT_texture_compression_bptc',
        'EXT_texture_compression_rgtc',
        'EXT_texture_filter_anisotropic',
        'KHR_parallel_shader_compile',
        'OES_texture_float_linear',
        'WEBGL_blend_func_extended',
        'WEBGL_compressed_texture_astc',
        'WEBGL_compressed_texture_etc',
        'WEBGL_compressed_texture_etc1',
        'WEBGL_compressed_texture_s3tc',
        'WEBGL_compressed_texture_s3tc_srgb',
        'WEBGL_debug_renderer_info',
        'WEBGL_debug_shaders',
        'WEBGL_lose_context',
        'WEBGL_multi_draw',
      ];
      // .getSupportedExtensions() can return null if context is lost, so coerce to empty array.
      return (ctx.getSupportedExtensions() || []).filter(ext => supportedExtensions.includes(ext));
    };
  
  
  var GL = {
  counter:1,
  buffers:[],
  programs:[],
  framebuffers:[],
  renderbuffers:[],
  textures:[],
  shaders:[],
  vaos:[],
  contexts:{
  },
  offscreenCanvases:{
  },
  queries:[],
  samplers:[],
  transformFeedbacks:[],
  syncs:[],
  stringCache:{
  },
  stringiCache:{
  },
  unpackAlignment:4,
  recordError:(errorCode) => {
        if (!GL.lastError) {
          GL.lastError = errorCode;
        }
      },
  getNewId:(table) => {
        var ret = GL.counter++;
        for (var i = table.length; i < ret; i++) {
          table[i] = null;
        }
        return ret;
      },
  genObject:(n, buffers, createFunction, objectTable
        ) => {
        for (var i = 0; i < n; i++) {
          var buffer = GLctx[createFunction]();
          var id = buffer && GL.getNewId(objectTable);
          if (buffer) {
            buffer.name = id;
            objectTable[id] = buffer;
          } else {
            GL.recordError(0x502 /* GL_INVALID_OPERATION */);
          }
          HEAP32[(((buffers)+(i*4))>>2)] = id;
        }
      },
  getSource:(shader, count, string, length) => {
        var source = '';
        for (var i = 0; i < count; ++i) {
          var len = length ? HEAPU32[(((length)+(i*4))>>2)] : undefined;
          source += UTF8ToString(HEAPU32[(((string)+(i*4))>>2)], len);
        }
        return source;
      },
  createContext:(/** @type {HTMLCanvasElement} */ canvas, webGLContextAttributes) => {
  
        // BUG: Workaround Safari WebGL issue: After successfully acquiring WebGL
        // context on a canvas, calling .getContext() will always return that
        // context independent of which 'webgl' or 'webgl2'
        // context version was passed. See:
        //   https://bugs.webkit.org/show_bug.cgi?id=222758
        // and:
        //   https://github.com/emscripten-core/emscripten/issues/13295.
        // TODO: Once the bug is fixed and shipped in Safari, adjust the Safari
        // version field in above check.
        if (!canvas.getContextSafariWebGL2Fixed) {
          canvas.getContextSafariWebGL2Fixed = canvas.getContext;
          /** @type {function(this:HTMLCanvasElement, string, (Object|null)=): (Object|null)} */
          function fixedGetContext(ver, attrs) {
            var gl = canvas.getContextSafariWebGL2Fixed(ver, attrs);
            return ((ver == 'webgl') == (gl instanceof WebGLRenderingContext)) ? gl : null;
          }
          canvas.getContext = fixedGetContext;
        }
  
        var ctx = canvas.getContext("webgl2", webGLContextAttributes);
  
        if (!ctx) return 0;
  
        var handle = GL.registerContext(ctx, webGLContextAttributes);
  
        return handle;
      },
  registerContext:(ctx, webGLContextAttributes) => {
        // with pthreads a context is a location in memory with some synchronized
        // data between threads
        var handle = _malloc(8);
        HEAPU32[(((handle)+(4))>>2)] = _pthread_self(); // the thread pointer of the thread that owns the control of the context
  
        var context = {
          handle,
          attributes: webGLContextAttributes,
          version: webGLContextAttributes.majorVersion,
          GLctx: ctx
        };
  
        // Store the created context object so that we can access the context
        // given a canvas without having to pass the parameters again.
        if (ctx.canvas) ctx.canvas.GLctxObject = context;
        GL.contexts[handle] = context;
        if (typeof webGLContextAttributes.enableExtensionsByDefault == 'undefined' || webGLContextAttributes.enableExtensionsByDefault) {
          GL.initExtensions(context);
        }
  
        return handle;
      },
  makeContextCurrent:(contextHandle) => {
  
        // Active Emscripten GL layer context object.
        GL.currentContext = GL.contexts[contextHandle];
        // Active WebGL context object.
        Module.ctx = GLctx = GL.currentContext?.GLctx;
        return !(contextHandle && !GLctx);
      },
  getContext:(contextHandle) => {
        return GL.contexts[contextHandle];
      },
  deleteContext:(contextHandle) => {
        if (GL.currentContext === GL.contexts[contextHandle]) {
          GL.currentContext = null;
        }
        if (typeof JSEvents == 'object') {
          // Release all JS event handlers on the DOM element that the GL context is
          // associated with since the context is now deleted.
          JSEvents.removeAllHandlersOnTarget(GL.contexts[contextHandle].GLctx.canvas);
        }
        // Make sure the canvas object no longer refers to the context object so
        // there are no GC surprises.
        if (GL.contexts[contextHandle] && GL.contexts[contextHandle].GLctx.canvas) {
          GL.contexts[contextHandle].GLctx.canvas.GLctxObject = undefined;
        }
        _free(GL.contexts[contextHandle].handle);
        GL.contexts[contextHandle] = null;
      },
  initExtensions:(context) => {
        // If this function is called without a specific context object, init the
        // extensions of the currently active context.
        context ||= GL.currentContext;
  
        if (context.initExtensionsDone) return;
        context.initExtensionsDone = true;
  
        var GLctx = context.GLctx;
  
        // Detect the presence of a few extensions manually, ction GL interop
        // layer itself will need to know if they exist.
  
        // Extensions that are available from WebGL >= 2 (no-op if called on a WebGL 1 context active)
        webgl_enable_WEBGL_draw_instanced_base_vertex_base_instance(GLctx);
        webgl_enable_WEBGL_multi_draw_instanced_base_vertex_base_instance(GLctx);
  
        // On WebGL 2, EXT_disjoint_timer_query is replaced with an alternative
        // that's based on core APIs, and exposes only the queryCounterEXT()
        // entrypoint.
        if (context.version >= 2) {
          GLctx.disjointTimerQueryExt = GLctx.getExtension("EXT_disjoint_timer_query_webgl2");
        }
  
        // However, Firefox exposes the WebGL 1 version on WebGL 2 as well and
        // thus we look for the WebGL 1 version again if the WebGL 2 version
        // isn't present. https://bugzilla.mozilla.org/show_bug.cgi?id=1328882
        if (context.version < 2 || !GLctx.disjointTimerQueryExt)
        {
          GLctx.disjointTimerQueryExt = GLctx.getExtension("EXT_disjoint_timer_query");
        }
  
        webgl_enable_WEBGL_multi_draw(GLctx);
  
        getEmscriptenSupportedExtensions(GLctx).forEach((ext) => {
          // WEBGL_lose_context, WEBGL_debug_renderer_info and WEBGL_debug_shaders
          // are not enabled by default.
          if (!ext.includes('lose_context') && !ext.includes('debug')) {
            // Call .getExtension() to enable that extension permanently.
            GLctx.getExtension(ext);
          }
        });
      },
  };
  
  var maybeCStringToJsString = (cString) => {
      // "cString > 2" checks if the input is a number, and isn't of the special
      // values we accept here, EMSCRIPTEN_EVENT_TARGET_* (which map to 0, 1, 2).
      // In other words, if cString > 2 then it's a pointer to a valid place in
      // memory, and points to a C string.
      return cString > 2 ? UTF8ToString(cString) : cString;
    };
  var findCanvasEventTarget = (target) => {
      target = maybeCStringToJsString(target);
  
      // When compiling with OffscreenCanvas support and looking up a canvas to target,
      // we first look up if the target Canvas has been transferred to OffscreenCanvas use.
      // These transfers are represented/tracked by GL.offscreenCanvases object, which contain
      // the OffscreenCanvas element for each regular Canvas element that has been transferred.
  
      // Note that each pthread/worker have their own set of GL.offscreenCanvases. That is,
      // when an OffscreenCanvas is transferred from a pthread/main thread to another pthread,
      // it will move in the GL.offscreenCanvases array between threads. Hence GL.offscreenCanvases
      // represents the set of OffscreenCanvases owned by the current calling thread.
  
      // First check out the list of OffscreenCanvases by CSS selector ID ('#myCanvasID')
      return GL.offscreenCanvases[target.substr(1)] // Remove '#' prefix
      // If not found, if one is querying by using DOM tag name selector 'canvas', grab the first
      // OffscreenCanvas that we can find.
       || (target == 'canvas' && Object.keys(GL.offscreenCanvases)[0])
      // If that is not found either, query via the regular DOM selector.
       || (typeof document != 'undefined' && document.querySelector(target));
    };
  var setCanvasElementSizeCallingThread = (target, width, height) => {
      var canvas = findCanvasEventTarget(target);
      if (!canvas) return -4;
  
      if (canvas.canvasSharedPtr) {
        // N.B. We hold the canvasSharedPtr info structure as the authoritative source for specifying the size of a canvas
        // since the actual canvas size changes are asynchronous if the canvas is owned by an OffscreenCanvas on another thread.
        // Therefore when setting the size, eagerly set the size of the canvas on the calling thread here, though this thread
        // might not be the one that actually ends up specifying the size, but the actual size change may be dispatched
        // as an asynchronous event below.
        HEAP32[((canvas.canvasSharedPtr)>>2)] = width;
        HEAP32[(((canvas.canvasSharedPtr)+(4))>>2)] = height;
      }
  
      if (canvas.offscreenCanvas || !canvas.controlTransferredOffscreen) {
        if (canvas.offscreenCanvas) canvas = canvas.offscreenCanvas;
        var autoResizeViewport = false;
        if (canvas.GLctxObject?.GLctx) {
          var prevViewport = canvas.GLctxObject.GLctx.getParameter(0xBA2 /* GL_VIEWPORT */);
          // TODO: Perhaps autoResizeViewport should only be true if FBO 0 is currently active?
          autoResizeViewport = (prevViewport[0] === 0 && prevViewport[1] === 0 && prevViewport[2] === canvas.width && prevViewport[3] === canvas.height);
        }
        canvas.width = width;
        canvas.height = height;
        if (autoResizeViewport) {
          // TODO: Add -sCANVAS_RESIZE_SETS_GL_VIEWPORT=0/1 option (default=1). This is commonly done and several graphics engines depend on this,
          // but this can be quite disruptive.
          canvas.GLctxObject.GLctx.viewport(0, 0, width, height);
        }
      } else if (canvas.canvasSharedPtr) {
        var targetThread = HEAPU32[(((canvas.canvasSharedPtr)+(8))>>2)];
        setOffscreenCanvasSizeOnTargetThread(targetThread, target, width, height);
        return 1; // This will have to be done asynchronously
      } else {
        return -4;
      }
      return 0;
    };
  
  
  
  function setCanvasElementSizeMainThread(target, width, height) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(32, 0, 1, target, width, height);
  return setCanvasElementSizeCallingThread(target, width, height)
  }
  
  
  /** @suppress {duplicate } */
  var _emscripten_set_canvas_element_size = (target, width, height) => {
      var canvas = findCanvasEventTarget(target);
      if (canvas) {
        return setCanvasElementSizeCallingThread(target, width, height);
      }
      return setCanvasElementSizeMainThread(target, width, height);
    };
  var __emscripten_set_offscreencanvas_size = _emscripten_set_canvas_element_size;


  var __emscripten_thread_set_strongref = (thread) => {
      // Called when a thread needs to be strongly referenced.
      // Currently only used for:
      // - keeping the "main" thread alive in PROXY_TO_PTHREAD mode;
      // - crashed threads that needs to propagate the uncaught exception
      //   back to the main thread.
      if (ENVIRONMENT_IS_NODE) {
        PThread.pthreads[thread].ref();
      }
    };

  function __gmtime_js(time, tmPtr) {
    time = bigintToI53Checked(time);
  
    
      var date = new Date(time * 1000);
      HEAP32[((tmPtr)>>2)] = date.getUTCSeconds();
      HEAP32[(((tmPtr)+(4))>>2)] = date.getUTCMinutes();
      HEAP32[(((tmPtr)+(8))>>2)] = date.getUTCHours();
      HEAP32[(((tmPtr)+(12))>>2)] = date.getUTCDate();
      HEAP32[(((tmPtr)+(16))>>2)] = date.getUTCMonth();
      HEAP32[(((tmPtr)+(20))>>2)] = date.getUTCFullYear()-1900;
      HEAP32[(((tmPtr)+(24))>>2)] = date.getUTCDay();
      var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
      var yday = ((date.getTime() - start) / (1000 * 60 * 60 * 24))|0;
      HEAP32[(((tmPtr)+(28))>>2)] = yday;
    ;
  }

  var isLeapYear = (year) => year%4 === 0 && (year%100 !== 0 || year%400 === 0);
  
  var MONTH_DAYS_LEAP_CUMULATIVE = [0,31,60,91,121,152,182,213,244,274,305,335];
  
  var MONTH_DAYS_REGULAR_CUMULATIVE = [0,31,59,90,120,151,181,212,243,273,304,334];
  var ydayFromDate = (date) => {
      var leap = isLeapYear(date.getFullYear());
      var monthDaysCumulative = (leap ? MONTH_DAYS_LEAP_CUMULATIVE : MONTH_DAYS_REGULAR_CUMULATIVE);
      var yday = monthDaysCumulative[date.getMonth()] + date.getDate() - 1; // -1 since it's days since Jan 1
  
      return yday;
    };
  
  function __localtime_js(time, tmPtr) {
    time = bigintToI53Checked(time);
  
    
      var date = new Date(time*1000);
      HEAP32[((tmPtr)>>2)] = date.getSeconds();
      HEAP32[(((tmPtr)+(4))>>2)] = date.getMinutes();
      HEAP32[(((tmPtr)+(8))>>2)] = date.getHours();
      HEAP32[(((tmPtr)+(12))>>2)] = date.getDate();
      HEAP32[(((tmPtr)+(16))>>2)] = date.getMonth();
      HEAP32[(((tmPtr)+(20))>>2)] = date.getFullYear()-1900;
      HEAP32[(((tmPtr)+(24))>>2)] = date.getDay();
  
      var yday = ydayFromDate(date)|0;
      HEAP32[(((tmPtr)+(28))>>2)] = yday;
      HEAP32[(((tmPtr)+(36))>>2)] = -(date.getTimezoneOffset() * 60);
  
      // Attention: DST is in December in South, and some regions don't have DST at all.
      var start = new Date(date.getFullYear(), 0, 1);
      var summerOffset = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
      var winterOffset = start.getTimezoneOffset();
      var dst = (summerOffset != winterOffset && date.getTimezoneOffset() == Math.min(winterOffset, summerOffset))|0;
      HEAP32[(((tmPtr)+(32))>>2)] = dst;
    ;
  }

  
  
  
  
  
  
  
  function __mmap_js(len, prot, flags, fd, offset, allocated, addr) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(33, 0, 1, len, prot, flags, fd, offset, allocated, addr);
  
    offset = bigintToI53Checked(offset);
  
    
  try {
  
      if (isNaN(offset)) return 61;
      var stream = SYSCALLS.getStreamFromFD(fd);
      var res = FS.mmap(stream, len, offset, prot, flags);
      var ptr = res.ptr;
      HEAP32[((allocated)>>2)] = res.allocated;
      HEAPU32[((addr)>>2)] = ptr;
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  ;
  
  }
  

  
  
  
  function __msync_js(addr, len, prot, flags, fd, offset) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(34, 0, 1, addr, len, prot, flags, fd, offset);
  
    offset = bigintToI53Checked(offset);
  
    
  try {
  
      if (isNaN(offset)) return 61;
      SYSCALLS.doMsync(addr, SYSCALLS.getStreamFromFD(fd), len, flags, offset);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  ;
  
  }
  

  
  
  
  function __munmap_js(addr, len, prot, flags, fd, offset) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(35, 0, 1, addr, len, prot, flags, fd, offset);
  
    offset = bigintToI53Checked(offset);
  
    
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      if (prot & 2) {
        SYSCALLS.doMsync(addr, stream, len, flags, offset);
      }
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  ;
  
  }
  

  var __tzset_js = (timezone, daylight, std_name, dst_name) => {
      // TODO: Use (malleable) environment variables instead of system settings.
      var currentYear = new Date().getFullYear();
      var winter = new Date(currentYear, 0, 1);
      var summer = new Date(currentYear, 6, 1);
      var winterOffset = winter.getTimezoneOffset();
      var summerOffset = summer.getTimezoneOffset();
  
      // Local standard timezone offset. Local standard time is not adjusted for
      // daylight savings.  This code uses the fact that getTimezoneOffset returns
      // a greater value during Standard Time versus Daylight Saving Time (DST).
      // Thus it determines the expected output during Standard Time, and it
      // compares whether the output of the given date the same (Standard) or less
      // (DST).
      var stdTimezoneOffset = Math.max(winterOffset, summerOffset);
  
      // timezone is specified as seconds west of UTC ("The external variable
      // `timezone` shall be set to the difference, in seconds, between
      // Coordinated Universal Time (UTC) and local standard time."), the same
      // as returned by stdTimezoneOffset.
      // See http://pubs.opengroup.org/onlinepubs/009695399/functions/tzset.html
      HEAPU32[((timezone)>>2)] = stdTimezoneOffset * 60;
  
      HEAP32[((daylight)>>2)] = Number(winterOffset != summerOffset);
  
      function extractZone(date) {
        var match = date.toTimeString().match(/\(([A-Za-z ]+)\)$/);
        return match ? match[1] : "GMT";
      };
      var winterName = extractZone(winter);
      var summerName = extractZone(summer);
      if (summerOffset < winterOffset) {
        // Northern hemisphere
        stringToUTF8(winterName, std_name, 7);
        stringToUTF8(summerName, dst_name, 7);
      } else {
        stringToUTF8(winterName, dst_name, 7);
        stringToUTF8(summerName, std_name, 7);
      }
    };

  var _abort = () => {
      abort('');
    };

  var readEmAsmArgsArray = [];
  var readEmAsmArgs = (sigPtr, buf) => {
      readEmAsmArgsArray.length = 0;
      var ch;
      // Most arguments are i32s, so shift the buffer pointer so it is a plain
      // index into HEAP32.
      while (ch = HEAPU8[sigPtr++]) {
        // Floats are always passed as doubles, so all types except for 'i'
        // are 8 bytes and require alignment.
        var wide = (ch != 105);
        wide &= (ch != 112);
        buf += wide && (buf % 8) ? 4 : 0;
        readEmAsmArgsArray.push(
          // Special case for pointers under wasm64 or CAN_ADDRESS_2GB mode.
          ch == 112 ? HEAPU32[((buf)>>2)] :
          ch == 106 ? HEAP64[((buf)>>3)] :
          ch == 105 ?
            HEAP32[((buf)>>2)] :
            HEAPF64[((buf)>>3)]
        );
        buf += wide ? 8 : 4;
      }
      return readEmAsmArgsArray;
    };
  
  var runMainThreadEmAsm = (emAsmAddr, sigPtr, argbuf, sync) => {
      var args = readEmAsmArgs(sigPtr, argbuf);
      if (ENVIRONMENT_IS_PTHREAD) {
        // EM_ASM functions are variadic, receiving the actual arguments as a buffer
        // in memory. the last parameter (argBuf) points to that data. We need to
        // always un-variadify that, *before proxying*, as in the async case this
        // is a stack allocation that LLVM made, which may go away before the main
        // thread gets the message. For that reason we handle proxying *after* the
        // call to readEmAsmArgs, and therefore we do that manually here instead
        // of using __proxy. (And dor simplicity, do the same in the sync
        // case as well, even though it's not strictly necessary, to keep the two
        // code paths as similar as possible on both sides.)
        return proxyToMainThread(0, emAsmAddr, sync, ...args);
      }
      return ASM_CONSTS[emAsmAddr](...args);
    };
  var _emscripten_asm_const_async_on_main_thread = (emAsmAddr, sigPtr, argbuf) => runMainThreadEmAsm(emAsmAddr, sigPtr, argbuf, 0);

  /** @suppress {duplicate } */
  var _emscripten_asm_const_int_sync_on_main_thread = (emAsmAddr, sigPtr, argbuf) => runMainThreadEmAsm(emAsmAddr, sigPtr, argbuf, 1);
  var _emscripten_asm_const_double_sync_on_main_thread = _emscripten_asm_const_int_sync_on_main_thread;

  var runEmAsmFunction = (code, sigPtr, argbuf) => {
      var args = readEmAsmArgs(sigPtr, argbuf);
      return ASM_CONSTS[code](...args);
    };
  var _emscripten_asm_const_int = (code, sigPtr, argbuf) => {
      return runEmAsmFunction(code, sigPtr, argbuf);
    };


  var _emscripten_asm_const_ptr_sync_on_main_thread = (emAsmAddr, sigPtr, argbuf) => runMainThreadEmAsm(emAsmAddr, sigPtr, argbuf, 1);

  
  var runtimeKeepalivePush = () => {
      runtimeKeepaliveCounter += 1;
    };
  var _emscripten_set_main_loop_timing = (mode, value) => {
      Browser.mainLoop.timingMode = mode;
      Browser.mainLoop.timingValue = value;
  
      if (!Browser.mainLoop.func) {
        return 1; // Return non-zero on failure, can't set timing mode when there is no main loop.
      }
  
      if (!Browser.mainLoop.running) {
        runtimeKeepalivePush();
        Browser.mainLoop.running = true;
      }
      if (mode == 0) {
        Browser.mainLoop.scheduler = function Browser_mainLoop_scheduler_setTimeout() {
          var timeUntilNextTick = Math.max(0, Browser.mainLoop.tickStartTime + value - _emscripten_get_now())|0;
          setTimeout(Browser.mainLoop.runner, timeUntilNextTick); // doing this each time means that on exception, we stop
        };
        Browser.mainLoop.method = 'timeout';
      } else if (mode == 1) {
        Browser.mainLoop.scheduler = function Browser_mainLoop_scheduler_rAF() {
          Browser.requestAnimationFrame(Browser.mainLoop.runner);
        };
        Browser.mainLoop.method = 'rAF';
      } else if (mode == 2) {
        if (typeof Browser.setImmediate == 'undefined') {
          if (typeof setImmediate == 'undefined') {
            // Emulate setImmediate. (note: not a complete polyfill, we don't emulate clearImmediate() to keep code size to minimum, since not needed)
            var setImmediates = [];
            var emscriptenMainLoopMessageId = 'setimmediate';
            /** @param {Event} event */
            var Browser_setImmediate_messageHandler = (event) => {
              // When called in current thread or Worker, the main loop ID is structured slightly different to accommodate for --proxy-to-worker runtime listening to Worker events,
              // so check for both cases.
              if (event.data === emscriptenMainLoopMessageId || event.data.target === emscriptenMainLoopMessageId) {
                event.stopPropagation();
                setImmediates.shift()();
              }
            };
            addEventListener("message", Browser_setImmediate_messageHandler, true);
            Browser.setImmediate = /** @type{function(function(): ?, ...?): number} */(function Browser_emulated_setImmediate(func) {
              setImmediates.push(func);
              if (ENVIRONMENT_IS_WORKER) {
                if (Module['setImmediates'] === undefined) Module['setImmediates'] = [];
                Module['setImmediates'].push(func);
                postMessage({target: emscriptenMainLoopMessageId}); // In --proxy-to-worker, route the message via proxyClient.js
              } else postMessage(emscriptenMainLoopMessageId, "*"); // On the main thread, can just send the message to itself.
            });
          } else {
            Browser.setImmediate = setImmediate;
          }
        }
        Browser.mainLoop.scheduler = function Browser_mainLoop_scheduler_setImmediate() {
          Browser.setImmediate(Browser.mainLoop.runner);
        };
        Browser.mainLoop.method = 'immediate';
      }
      return 0;
    };
  
  var _emscripten_get_now;
      // Pthreads need their clocks synchronized to the execution of the main
      // thread, so, when using them, make sure to adjust all timings to the
      // respective time origins.
      _emscripten_get_now = () => performance.timeOrigin + performance.now();
  ;
  
  
  
  var runtimeKeepalivePop = () => {
      runtimeKeepaliveCounter -= 1;
    };
  
    /**
     * @param {number=} arg
     * @param {boolean=} noSetTiming
     */
  var setMainLoop = (browserIterationFunc, fps, simulateInfiniteLoop, arg, noSetTiming) => {
      Browser.mainLoop.func = browserIterationFunc;
      Browser.mainLoop.arg = arg;
  
      // Closure compiler bug(?): Closure does not see that the assignment
      //   var thisMainLoopId = Browser.mainLoop.currentlyRunningMainloop
      // is a value copy of a number (even with the JSDoc @type annotation)
      // but optimizeis the code as if the assignment was a reference assignment,
      // which results in Browser.mainLoop.pause() not working. Hence use a
      // workaround to make Closure believe this is a value copy that should occur:
      // (TODO: Minimize this down to a small test case and report - was unable
      // to reproduce in a small written test case)
      /** @type{number} */
      var thisMainLoopId = (() => Browser.mainLoop.currentlyRunningMainloop)();
      function checkIsRunning() {
        if (thisMainLoopId < Browser.mainLoop.currentlyRunningMainloop) {
          runtimeKeepalivePop();
          maybeExit();
          return false;
        }
        return true;
      }
  
      // We create the loop runner here but it is not actually running until
      // _emscripten_set_main_loop_timing is called (which might happen a
      // later time).  This member signifies that the current runner has not
      // yet been started so that we can call runtimeKeepalivePush when it
      // gets it timing set for the first time.
      Browser.mainLoop.running = false;
      Browser.mainLoop.runner = function Browser_mainLoop_runner() {
        if (ABORT) return;
        if (Browser.mainLoop.queue.length > 0) {
          var start = Date.now();
          var blocker = Browser.mainLoop.queue.shift();
          blocker.func(blocker.arg);
          if (Browser.mainLoop.remainingBlockers) {
            var remaining = Browser.mainLoop.remainingBlockers;
            var next = remaining%1 == 0 ? remaining-1 : Math.floor(remaining);
            if (blocker.counted) {
              Browser.mainLoop.remainingBlockers = next;
            } else {
              // not counted, but move the progress along a tiny bit
              next = next + 0.5; // do not steal all the next one's progress
              Browser.mainLoop.remainingBlockers = (8*remaining + next)/9;
            }
          }
          Browser.mainLoop.updateStatus();
  
          // catches pause/resume main loop from blocker execution
          if (!checkIsRunning()) return;
  
          setTimeout(Browser.mainLoop.runner, 0);
          return;
        }
  
        // catch pauses from non-main loop sources
        if (!checkIsRunning()) return;
  
        // Implement very basic swap interval control
        Browser.mainLoop.currentFrameNumber = Browser.mainLoop.currentFrameNumber + 1 | 0;
        if (Browser.mainLoop.timingMode == 1 && Browser.mainLoop.timingValue > 1 && Browser.mainLoop.currentFrameNumber % Browser.mainLoop.timingValue != 0) {
          // Not the scheduled time to render this frame - skip.
          Browser.mainLoop.scheduler();
          return;
        } else if (Browser.mainLoop.timingMode == 0) {
          Browser.mainLoop.tickStartTime = _emscripten_get_now();
        }
  
        // Signal GL rendering layer that processing of a new frame is about to start. This helps it optimize
        // VBO double-buffering and reduce GPU stalls.
  
        // If the current GL context is an OffscreenCanvas, but it was initialized with implicit swap mode, perform the swap on behalf of the user.
        if (typeof GL != 'undefined' && GL.currentContext && !GL.currentContextIsProxied && !GL.currentContext.attributes.explicitSwapControl && GL.currentContext.GLctx.commit) {
          GL.currentContext.GLctx.commit();
        }
  
        Browser.mainLoop.runIter(browserIterationFunc);
  
        // catch pauses from the main loop itself
        if (!checkIsRunning()) return;
  
        // Queue new audio data. This is important to be right after the main loop invocation, so that we will immediately be able
        // to queue the newest produced audio samples.
        // TODO: Consider adding pre- and post- rAF callbacks so that GL.newRenderingFrameStarted() and SDL.audio.queueNewAudioData()
        //       do not need to be hardcoded into this function, but can be more generic.
        if (typeof SDL == 'object') SDL.audio?.queueNewAudioData?.();
  
        Browser.mainLoop.scheduler();
      }
  
      if (!noSetTiming) {
        if (fps && fps > 0) {
          _emscripten_set_main_loop_timing(0, 1000.0 / fps);
        } else {
          // Do rAF by rendering each frame (no decimating)
          _emscripten_set_main_loop_timing(1, 1);
        }
  
        Browser.mainLoop.scheduler();
      }
  
      if (simulateInfiniteLoop) {
        throw 'unwind';
      }
    };
  
  
  
  
  /** @param {number=} timeout */
  var safeSetTimeout = (func, timeout) => {
      runtimeKeepalivePush();
      return setTimeout(() => {
        runtimeKeepalivePop();
        callUserCallback(func);
      }, timeout);
    };
  
  var warnOnce = (text) => {
      warnOnce.shown ||= {};
      if (!warnOnce.shown[text]) {
        warnOnce.shown[text] = 1;
        if (ENVIRONMENT_IS_NODE) text = 'warning: ' + text;
        err(text);
      }
    };
  
  
  
  
  
  var Browser = {
  mainLoop:{
  running:false,
  scheduler:null,
  method:"",
  currentlyRunningMainloop:0,
  func:null,
  arg:0,
  timingMode:0,
  timingValue:0,
  currentFrameNumber:0,
  queue:[],
  pause() {
          Browser.mainLoop.scheduler = null;
          // Incrementing this signals the previous main loop that it's now become old, and it must return.
          Browser.mainLoop.currentlyRunningMainloop++;
        },
  resume() {
          Browser.mainLoop.currentlyRunningMainloop++;
          var timingMode = Browser.mainLoop.timingMode;
          var timingValue = Browser.mainLoop.timingValue;
          var func = Browser.mainLoop.func;
          Browser.mainLoop.func = null;
          // do not set timing and call scheduler, we will do it on the next lines
          setMainLoop(func, 0, false, Browser.mainLoop.arg, true);
          _emscripten_set_main_loop_timing(timingMode, timingValue);
          Browser.mainLoop.scheduler();
        },
  updateStatus() {
          if (Module['setStatus']) {
            var message = Module['statusMessage'] || 'Please wait...';
            var remaining = Browser.mainLoop.remainingBlockers;
            var expected = Browser.mainLoop.expectedBlockers;
            if (remaining) {
              if (remaining < expected) {
                Module['setStatus'](`{message} ({expected - remaining}/{expected})`);
              } else {
                Module['setStatus'](message);
              }
            } else {
              Module['setStatus']('');
            }
          }
        },
  runIter(func) {
          if (ABORT) return;
          if (Module['preMainLoop']) {
            var preRet = Module['preMainLoop']();
            if (preRet === false) {
              return; // |return false| skips a frame
            }
          }
          callUserCallback(func);
          Module['postMainLoop']?.();
        },
  },
  isFullscreen:false,
  pointerLock:false,
  moduleContextCreatedCallbacks:[],
  workers:[],
  init() {
        if (Browser.initted) return;
        Browser.initted = true;
  
        // Support for plugins that can process preloaded files. You can add more of these to
        // your app by creating and appending to preloadPlugins.
        //
        // Each plugin is asked if it can handle a file based on the file's name. If it can,
        // it is given the file's raw data. When it is done, it calls a callback with the file's
        // (possibly modified) data. For example, a plugin might decompress a file, or it
        // might create some side data structure for use later (like an Image element, etc.).
  
        var imagePlugin = {};
        imagePlugin['canHandle'] = function imagePlugin_canHandle(name) {
          return !Module.noImageDecoding && /\.(jpg|jpeg|png|bmp)$/i.test(name);
        };
        imagePlugin['handle'] = function imagePlugin_handle(byteArray, name, onload, onerror) {
          var b = new Blob([byteArray], { type: Browser.getMimetype(name) });
          if (b.size !== byteArray.length) { // Safari bug #118630
            // Safari's Blob can only take an ArrayBuffer
            b = new Blob([(new Uint8Array(byteArray)).buffer], { type: Browser.getMimetype(name) });
          }
          var url = URL.createObjectURL(b);
          var img = new Image();
          img.onload = () => {
            var canvas = /** @type {!HTMLCanvasElement} */ (document.createElement('canvas'));
            canvas.width = img.width;
            canvas.height = img.height;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            preloadedImages[name] = canvas;
            URL.revokeObjectURL(url);
            onload?.(byteArray);
          };
          img.onerror = (event) => {
            err(`Image ${url} could not be decoded`);
            onerror?.();
          };
          img.src = url;
        };
        preloadPlugins.push(imagePlugin);
  
        var audioPlugin = {};
        audioPlugin['canHandle'] = function audioPlugin_canHandle(name) {
          return !Module.noAudioDecoding && name.substr(-4) in { '.ogg': 1, '.wav': 1, '.mp3': 1 };
        };
        audioPlugin['handle'] = function audioPlugin_handle(byteArray, name, onload, onerror) {
          var done = false;
          function finish(audio) {
            if (done) return;
            done = true;
            preloadedAudios[name] = audio;
            onload?.(byteArray);
          }
          function fail() {
            if (done) return;
            done = true;
            preloadedAudios[name] = new Audio(); // empty shim
            onerror?.();
          }
          var b = new Blob([byteArray], { type: Browser.getMimetype(name) });
          var url = URL.createObjectURL(b); // XXX we never revoke this!
          var audio = new Audio();
          audio.addEventListener('canplaythrough', () => finish(audio), false); // use addEventListener due to chromium bug 124926
          audio.onerror = function audio_onerror(event) {
            if (done) return;
            err(`warning: browser could not fully decode audio ${name}, trying slower base64 approach`);
            function encode64(data) {
              var BASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
              var PAD = '=';
              var ret = '';
              var leftchar = 0;
              var leftbits = 0;
              for (var i = 0; i < data.length; i++) {
                leftchar = (leftchar << 8) | data[i];
                leftbits += 8;
                while (leftbits >= 6) {
                  var curr = (leftchar >> (leftbits-6)) & 0x3f;
                  leftbits -= 6;
                  ret += BASE[curr];
                }
              }
              if (leftbits == 2) {
                ret += BASE[(leftchar&3) << 4];
                ret += PAD + PAD;
              } else if (leftbits == 4) {
                ret += BASE[(leftchar&0xf) << 2];
                ret += PAD;
              }
              return ret;
            }
            audio.src = 'data:audio/x-' + name.substr(-3) + ';base64,' + encode64(byteArray);
            finish(audio); // we don't wait for confirmation this worked - but it's worth trying
          };
          audio.src = url;
          // workaround for chrome bug 124926 - we do not always get oncanplaythrough or onerror
          safeSetTimeout(() => {
            finish(audio); // try to use it even though it is not necessarily ready to play
          }, 10000);
        };
        preloadPlugins.push(audioPlugin);
  
        // Canvas event setup
  
        function pointerLockChange() {
          Browser.pointerLock = document['pointerLockElement'] === Module['canvas'] ||
                                document['mozPointerLockElement'] === Module['canvas'] ||
                                document['webkitPointerLockElement'] === Module['canvas'] ||
                                document['msPointerLockElement'] === Module['canvas'];
        }
        var canvas = Module['canvas'];
        if (canvas) {
          // forced aspect ratio can be enabled by defining 'forcedAspectRatio' on Module
          // Module['forcedAspectRatio'] = 4 / 3;
  
          canvas.requestPointerLock = canvas['requestPointerLock'] ||
                                      canvas['mozRequestPointerLock'] ||
                                      canvas['webkitRequestPointerLock'] ||
                                      canvas['msRequestPointerLock'] ||
                                      (() => {});
          canvas.exitPointerLock = document['exitPointerLock'] ||
                                   document['mozExitPointerLock'] ||
                                   document['webkitExitPointerLock'] ||
                                   document['msExitPointerLock'] ||
                                   (() => {}); // no-op if function does not exist
          canvas.exitPointerLock = canvas.exitPointerLock.bind(document);
  
          document.addEventListener('pointerlockchange', pointerLockChange, false);
          document.addEventListener('mozpointerlockchange', pointerLockChange, false);
          document.addEventListener('webkitpointerlockchange', pointerLockChange, false);
          document.addEventListener('mspointerlockchange', pointerLockChange, false);
  
          if (Module['elementPointerLock']) {
            canvas.addEventListener("click", (ev) => {
              if (!Browser.pointerLock && Module['canvas'].requestPointerLock) {
                Module['canvas'].requestPointerLock();
                ev.preventDefault();
              }
            }, false);
          }
        }
      },
  createContext(/** @type {HTMLCanvasElement} */ canvas, useWebGL, setInModule, webGLContextAttributes) {
        if (useWebGL && Module.ctx && canvas == Module.canvas) return Module.ctx; // no need to recreate GL context if it's already been created for this canvas.
  
        var ctx;
        var contextHandle;
        if (useWebGL) {
          // For GLES2/desktop GL compatibility, adjust a few defaults to be different to WebGL defaults, so that they align better with the desktop defaults.
          var contextAttributes = {
            antialias: false,
            alpha: false,
            majorVersion: 2,
          };
  
          if (webGLContextAttributes) {
            for (var attribute in webGLContextAttributes) {
              contextAttributes[attribute] = webGLContextAttributes[attribute];
            }
          }
  
          // This check of existence of GL is here to satisfy Closure compiler, which yells if variable GL is referenced below but GL object is not
          // actually compiled in because application is not doing any GL operations. TODO: Ideally if GL is not being used, this function
          // Browser.createContext() should not even be emitted.
          if (typeof GL != 'undefined') {
            contextHandle = GL.createContext(canvas, contextAttributes);
            if (contextHandle) {
              ctx = GL.getContext(contextHandle).GLctx;
            }
          }
        } else {
          ctx = canvas.getContext('2d');
        }
  
        if (!ctx) return null;
  
        if (setInModule) {
          Module.ctx = ctx;
          if (useWebGL) GL.makeContextCurrent(contextHandle);
          Module.useWebGL = useWebGL;
          Browser.moduleContextCreatedCallbacks.forEach((callback) => callback());
          Browser.init();
        }
        return ctx;
      },
  destroyContext(canvas, useWebGL, setInModule) {},
  fullscreenHandlersInstalled:false,
  lockPointer:undefined,
  resizeCanvas:undefined,
  requestFullscreen(lockPointer, resizeCanvas) {
        Browser.lockPointer = lockPointer;
        Browser.resizeCanvas = resizeCanvas;
        if (typeof Browser.lockPointer == 'undefined') Browser.lockPointer = true;
        if (typeof Browser.resizeCanvas == 'undefined') Browser.resizeCanvas = false;
  
        var canvas = Module['canvas'];
        function fullscreenChange() {
          Browser.isFullscreen = false;
          var canvasContainer = canvas.parentNode;
          if ((document['fullscreenElement'] || document['mozFullScreenElement'] ||
               document['msFullscreenElement'] || document['webkitFullscreenElement'] ||
               document['webkitCurrentFullScreenElement']) === canvasContainer) {
            canvas.exitFullscreen = Browser.exitFullscreen;
            if (Browser.lockPointer) canvas.requestPointerLock();
            Browser.isFullscreen = true;
            if (Browser.resizeCanvas) {
              Browser.setFullscreenCanvasSize();
            } else {
              Browser.updateCanvasDimensions(canvas);
            }
          } else {
            // remove the full screen specific parent of the canvas again to restore the HTML structure from before going full screen
            canvasContainer.parentNode.insertBefore(canvas, canvasContainer);
            canvasContainer.parentNode.removeChild(canvasContainer);
  
            if (Browser.resizeCanvas) {
              Browser.setWindowedCanvasSize();
            } else {
              Browser.updateCanvasDimensions(canvas);
            }
          }
          Module['onFullScreen']?.(Browser.isFullscreen);
          Module['onFullscreen']?.(Browser.isFullscreen);
        }
  
        if (!Browser.fullscreenHandlersInstalled) {
          Browser.fullscreenHandlersInstalled = true;
          document.addEventListener('fullscreenchange', fullscreenChange, false);
          document.addEventListener('mozfullscreenchange', fullscreenChange, false);
          document.addEventListener('webkitfullscreenchange', fullscreenChange, false);
          document.addEventListener('MSFullscreenChange', fullscreenChange, false);
        }
  
        // create a new parent to ensure the canvas has no siblings. this allows browsers to optimize full screen performance when its parent is the full screen root
        var canvasContainer = document.createElement("div");
        canvas.parentNode.insertBefore(canvasContainer, canvas);
        canvasContainer.appendChild(canvas);
  
        // use parent of canvas as full screen root to allow aspect ratio correction (Firefox stretches the root to screen size)
        canvasContainer.requestFullscreen = canvasContainer['requestFullscreen'] ||
                                            canvasContainer['mozRequestFullScreen'] ||
                                            canvasContainer['msRequestFullscreen'] ||
                                           (canvasContainer['webkitRequestFullscreen'] ? () => canvasContainer['webkitRequestFullscreen'](Element['ALLOW_KEYBOARD_INPUT']) : null) ||
                                           (canvasContainer['webkitRequestFullScreen'] ? () => canvasContainer['webkitRequestFullScreen'](Element['ALLOW_KEYBOARD_INPUT']) : null);
  
        canvasContainer.requestFullscreen();
      },
  exitFullscreen() {
        // This is workaround for chrome. Trying to exit from fullscreen
        // not in fullscreen state will cause "TypeError: Document not active"
        // in chrome. See https://github.com/emscripten-core/emscripten/pull/8236
        if (!Browser.isFullscreen) {
          return false;
        }
  
        var CFS = document['exitFullscreen'] ||
                  document['cancelFullScreen'] ||
                  document['mozCancelFullScreen'] ||
                  document['msExitFullscreen'] ||
                  document['webkitCancelFullScreen'] ||
            (() => {});
        CFS.apply(document, []);
        return true;
      },
  nextRAF:0,
  fakeRequestAnimationFrame(func) {
        // try to keep 60fps between calls to here
        var now = Date.now();
        if (Browser.nextRAF === 0) {
          Browser.nextRAF = now + 1000/60;
        } else {
          while (now + 2 >= Browser.nextRAF) { // fudge a little, to avoid timer jitter causing us to do lots of delay:0
            Browser.nextRAF += 1000/60;
          }
        }
        var delay = Math.max(Browser.nextRAF - now, 0);
        setTimeout(func, delay);
      },
  requestAnimationFrame(func) {
        if (typeof requestAnimationFrame == 'function') {
          requestAnimationFrame(func);
          return;
        }
        var RAF = Browser.fakeRequestAnimationFrame;
        RAF(func);
      },
  safeSetTimeout(func, timeout) {
        // Legacy function, this is used by the SDL2 port so we need to keep it
        // around at least until that is updated.
        // See https://github.com/libsdl-org/SDL/pull/6304
        return safeSetTimeout(func, timeout);
      },
  safeRequestAnimationFrame(func) {
        runtimeKeepalivePush();
        return Browser.requestAnimationFrame(() => {
          runtimeKeepalivePop();
          callUserCallback(func);
        });
      },
  getMimetype(name) {
        return {
          'jpg': 'image/jpeg',
          'jpeg': 'image/jpeg',
          'png': 'image/png',
          'bmp': 'image/bmp',
          'ogg': 'audio/ogg',
          'wav': 'audio/wav',
          'mp3': 'audio/mpeg'
        }[name.substr(name.lastIndexOf('.')+1)];
      },
  getUserMedia(func) {
        window.getUserMedia ||= navigator['getUserMedia'] ||
                                navigator['mozGetUserMedia'];
        window.getUserMedia(func);
      },
  getMovementX(event) {
        return event['movementX'] ||
               event['mozMovementX'] ||
               event['webkitMovementX'] ||
               0;
      },
  getMovementY(event) {
        return event['movementY'] ||
               event['mozMovementY'] ||
               event['webkitMovementY'] ||
               0;
      },
  getMouseWheelDelta(event) {
        var delta = 0;
        switch (event.type) {
          case 'DOMMouseScroll':
            // 3 lines make up a step
            delta = event.detail / 3;
            break;
          case 'mousewheel':
            // 120 units make up a step
            delta = event.wheelDelta / 120;
            break;
          case 'wheel':
            delta = event.deltaY
            switch (event.deltaMode) {
              case 0:
                // DOM_DELTA_PIXEL: 100 pixels make up a step
                delta /= 100;
                break;
              case 1:
                // DOM_DELTA_LINE: 3 lines make up a step
                delta /= 3;
                break;
              case 2:
                // DOM_DELTA_PAGE: A page makes up 80 steps
                delta *= 80;
                break;
              default:
                throw 'unrecognized mouse wheel delta mode: ' + event.deltaMode;
            }
            break;
          default:
            throw 'unrecognized mouse wheel event: ' + event.type;
        }
        return delta;
      },
  mouseX:0,
  mouseY:0,
  mouseMovementX:0,
  mouseMovementY:0,
  touches:{
  },
  lastTouches:{
  },
  calculateMouseCoords(pageX, pageY) {
        // Calculate the movement based on the changes
        // in the coordinates.
        var rect = Module["canvas"].getBoundingClientRect();
        var cw = Module["canvas"].width;
        var ch = Module["canvas"].height;
  
        // Neither .scrollX or .pageXOffset are defined in a spec, but
        // we prefer .scrollX because it is currently in a spec draft.
        // (see: http://www.w3.org/TR/2013/WD-cssom-view-20131217/)
        var scrollX = ((typeof window.scrollX != 'undefined') ? window.scrollX : window.pageXOffset);
        var scrollY = ((typeof window.scrollY != 'undefined') ? window.scrollY : window.pageYOffset);
        var adjustedX = pageX - (scrollX + rect.left);
        var adjustedY = pageY - (scrollY + rect.top);
  
        // the canvas might be CSS-scaled compared to its backbuffer;
        // SDL-using content will want mouse coordinates in terms
        // of backbuffer units.
        adjustedX = adjustedX * (cw / rect.width);
        adjustedY = adjustedY * (ch / rect.height);
  
        return { x: adjustedX, y: adjustedY };
      },
  setMouseCoords(pageX, pageY) {
        const {x, y} = Browser.calculateMouseCoords(pageX, pageY);
        Browser.mouseMovementX = x - Browser.mouseX;
        Browser.mouseMovementY = y - Browser.mouseY;
        Browser.mouseX = x;
        Browser.mouseY = y;
      },
  calculateMouseEvent(event) { // event should be mousemove, mousedown or mouseup
        if (Browser.pointerLock) {
          // When the pointer is locked, calculate the coordinates
          // based on the movement of the mouse.
          // Workaround for Firefox bug 764498
          if (event.type != 'mousemove' &&
              ('mozMovementX' in event)) {
            Browser.mouseMovementX = Browser.mouseMovementY = 0;
          } else {
            Browser.mouseMovementX = Browser.getMovementX(event);
            Browser.mouseMovementY = Browser.getMovementY(event);
          }
  
          // check if SDL is available
          if (typeof SDL != "undefined") {
            Browser.mouseX = SDL.mouseX + Browser.mouseMovementX;
            Browser.mouseY = SDL.mouseY + Browser.mouseMovementY;
          } else {
            // just add the mouse delta to the current absolute mouse position
            // FIXME: ideally this should be clamped against the canvas size and zero
            Browser.mouseX += Browser.mouseMovementX;
            Browser.mouseY += Browser.mouseMovementY;
          }
        } else {
          if (event.type === 'touchstart' || event.type === 'touchend' || event.type === 'touchmove') {
            var touch = event.touch;
            if (touch === undefined) {
              return; // the "touch" property is only defined in SDL
  
            }
            var coords = Browser.calculateMouseCoords(touch.pageX, touch.pageY);
  
            if (event.type === 'touchstart') {
              Browser.lastTouches[touch.identifier] = coords;
              Browser.touches[touch.identifier] = coords;
            } else if (event.type === 'touchend' || event.type === 'touchmove') {
              var last = Browser.touches[touch.identifier];
              last ||= coords;
              Browser.lastTouches[touch.identifier] = last;
              Browser.touches[touch.identifier] = coords;
            }
            return;
          }
  
          Browser.setMouseCoords(event.pageX, event.pageY);
        }
      },
  resizeListeners:[],
  updateResizeListeners() {
        var canvas = Module['canvas'];
        Browser.resizeListeners.forEach((listener) => listener(canvas.width, canvas.height));
      },
  setCanvasSize(width, height, noUpdates) {
        var canvas = Module['canvas'];
        Browser.updateCanvasDimensions(canvas, width, height);
        if (!noUpdates) Browser.updateResizeListeners();
      },
  windowedWidth:0,
  windowedHeight:0,
  setFullscreenCanvasSize() {
        // check if SDL is available
        if (typeof SDL != "undefined") {
          var flags = HEAPU32[((SDL.screen)>>2)];
          flags = flags | 0x00800000; // set SDL_FULLSCREEN flag
          HEAP32[((SDL.screen)>>2)] = flags;
        }
        Browser.updateCanvasDimensions(Module['canvas']);
        Browser.updateResizeListeners();
      },
  setWindowedCanvasSize() {
        // check if SDL is available
        if (typeof SDL != "undefined") {
          var flags = HEAPU32[((SDL.screen)>>2)];
          flags = flags & ~0x00800000; // clear SDL_FULLSCREEN flag
          HEAP32[((SDL.screen)>>2)] = flags;
        }
        Browser.updateCanvasDimensions(Module['canvas']);
        Browser.updateResizeListeners();
      },
  updateCanvasDimensions(canvas, wNative, hNative) {
        if (wNative && hNative) {
          canvas.widthNative = wNative;
          canvas.heightNative = hNative;
        } else {
          wNative = canvas.widthNative;
          hNative = canvas.heightNative;
        }
        var w = wNative;
        var h = hNative;
        if (Module['forcedAspectRatio'] && Module['forcedAspectRatio'] > 0) {
          if (w/h < Module['forcedAspectRatio']) {
            w = Math.round(h * Module['forcedAspectRatio']);
          } else {
            h = Math.round(w / Module['forcedAspectRatio']);
          }
        }
        if (((document['fullscreenElement'] || document['mozFullScreenElement'] ||
             document['msFullscreenElement'] || document['webkitFullscreenElement'] ||
             document['webkitCurrentFullScreenElement']) === canvas.parentNode) && (typeof screen != 'undefined')) {
           var factor = Math.min(screen.width / w, screen.height / h);
           w = Math.round(w * factor);
           h = Math.round(h * factor);
        }
        if (Browser.resizeCanvas) {
          if (canvas.width  != w) canvas.width  = w;
          if (canvas.height != h) canvas.height = h;
          if (typeof canvas.style != 'undefined') {
            canvas.style.removeProperty( "width");
            canvas.style.removeProperty("height");
          }
        } else {
          if (canvas.width  != wNative) canvas.width  = wNative;
          if (canvas.height != hNative) canvas.height = hNative;
          if (typeof canvas.style != 'undefined') {
            if (w != wNative || h != hNative) {
              canvas.style.setProperty( "width", w + "px", "important");
              canvas.style.setProperty("height", h + "px", "important");
            } else {
              canvas.style.removeProperty( "width");
              canvas.style.removeProperty("height");
            }
          }
        }
      },
  };
  var _emscripten_cancel_main_loop = () => {
      Browser.mainLoop.pause();
      Browser.mainLoop.func = null;
    };

  
  var _emscripten_check_blocking_allowed = () => {
    };

  var _emscripten_clear_timeout = clearTimeout;

  var _emscripten_console_error = (str) => {
      console.error(UTF8ToString(str));
    };

  var _emscripten_date_now = () => Date.now();

  
  var currentFullscreenStrategy = {
  };
  
  
  
  
  
  var getCanvasSizeCallingThread = (target, width, height) => {
      var canvas = findCanvasEventTarget(target);
      if (!canvas) return -4;
  
      if (canvas.canvasSharedPtr) {
        // N.B. Reading the size of the Canvas takes priority from our shared state structure, which is not the actual size.
        // However if is possible that there is a canvas size set event pending on an OffscreenCanvas owned by another thread,
        // so that the real sizes of the canvas have not updated yet. Therefore reading the real values would be racy.
        var w = HEAP32[((canvas.canvasSharedPtr)>>2)];
        var h = HEAP32[(((canvas.canvasSharedPtr)+(4))>>2)];
        HEAP32[((width)>>2)] = w;
        HEAP32[((height)>>2)] = h;
      } else if (canvas.offscreenCanvas) {
        HEAP32[((width)>>2)] = canvas.offscreenCanvas.width;
        HEAP32[((height)>>2)] = canvas.offscreenCanvas.height;
      } else
      if (!canvas.controlTransferredOffscreen) {
        HEAP32[((width)>>2)] = canvas.width;
        HEAP32[((height)>>2)] = canvas.height;
      } else {
        return -4;
      }
      return 0;
    };
  
  
  
  function getCanvasSizeMainThread(target, width, height) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(37, 0, 1, target, width, height);
  return getCanvasSizeCallingThread(target, width, height)
  }
  
  
  var _emscripten_get_canvas_element_size = (target, width, height) => {
      var canvas = findCanvasEventTarget(target);
      if (canvas) {
        return getCanvasSizeCallingThread(target, width, height);
      }
      return getCanvasSizeMainThread(target, width, height);
    };
  
  
  
  var stringToUTF8OnStack = (str) => {
      var size = lengthBytesUTF8(str) + 1;
      var ret = stackAlloc(size);
      stringToUTF8(str, ret, size);
      return ret;
    };
  var getCanvasElementSize = (target) => withStackSave(() => {
      var w = stackAlloc(8);
      var h = w + 4;
  
      var targetInt = stringToUTF8OnStack(target.id);
      var ret = _emscripten_get_canvas_element_size(targetInt, w, h);
      var size = [HEAP32[((w)>>2)], HEAP32[((h)>>2)]];
      return size;
    });
  
  
  
  var setCanvasElementSize = (target, width, height) => {
      if (!target.controlTransferredOffscreen) {
        target.width = width;
        target.height = height;
      } else {
        // This function is being called from high-level JavaScript code instead of asm.js/Wasm,
        // and it needs to synchronously proxy over to another thread, so marshal the string onto the heap to do the call.
        withStackSave(() => {
          var targetInt = stringToUTF8OnStack(target.id);
          _emscripten_set_canvas_element_size(targetInt, width, height);
        });
      }
    };
  
  var registerRestoreOldStyle = (canvas) => {
      var canvasSize = getCanvasElementSize(canvas);
      var oldWidth = canvasSize[0];
      var oldHeight = canvasSize[1];
      var oldCssWidth = canvas.style.width;
      var oldCssHeight = canvas.style.height;
      var oldBackgroundColor = canvas.style.backgroundColor; // Chrome reads color from here.
      var oldDocumentBackgroundColor = document.body.style.backgroundColor; // IE11 reads color from here.
      // Firefox always has black background color.
      var oldPaddingLeft = canvas.style.paddingLeft; // Chrome, FF, Safari
      var oldPaddingRight = canvas.style.paddingRight;
      var oldPaddingTop = canvas.style.paddingTop;
      var oldPaddingBottom = canvas.style.paddingBottom;
      var oldMarginLeft = canvas.style.marginLeft; // IE11
      var oldMarginRight = canvas.style.marginRight;
      var oldMarginTop = canvas.style.marginTop;
      var oldMarginBottom = canvas.style.marginBottom;
      var oldDocumentBodyMargin = document.body.style.margin;
      var oldDocumentOverflow = document.documentElement.style.overflow; // Chrome, Firefox
      var oldDocumentScroll = document.body.scroll; // IE
      var oldImageRendering = canvas.style.imageRendering;
  
      function restoreOldStyle() {
        var fullscreenElement = document.fullscreenElement
          || document.webkitFullscreenElement
          ;
        if (!fullscreenElement) {
          document.removeEventListener('fullscreenchange', restoreOldStyle);
  
          // Unprefixed Fullscreen API shipped in Chromium 71 (https://bugs.chromium.org/p/chromium/issues/detail?id=383813)
          // As of Safari 13.0.3 on macOS Catalina 10.15.1 still ships with prefixed webkitfullscreenchange. TODO: revisit this check once Safari ships unprefixed version.
          document.removeEventListener('webkitfullscreenchange', restoreOldStyle);
  
          setCanvasElementSize(canvas, oldWidth, oldHeight);
  
          canvas.style.width = oldCssWidth;
          canvas.style.height = oldCssHeight;
          canvas.style.backgroundColor = oldBackgroundColor; // Chrome
          // IE11 hack: assigning 'undefined' or an empty string to document.body.style.backgroundColor has no effect, so first assign back the default color
          // before setting the undefined value. Setting undefined value is also important, or otherwise we would later treat that as something that the user
          // had explicitly set so subsequent fullscreen transitions would not set background color properly.
          if (!oldDocumentBackgroundColor) document.body.style.backgroundColor = 'white';
          document.body.style.backgroundColor = oldDocumentBackgroundColor; // IE11
          canvas.style.paddingLeft = oldPaddingLeft; // Chrome, FF, Safari
          canvas.style.paddingRight = oldPaddingRight;
          canvas.style.paddingTop = oldPaddingTop;
          canvas.style.paddingBottom = oldPaddingBottom;
          canvas.style.marginLeft = oldMarginLeft; // IE11
          canvas.style.marginRight = oldMarginRight;
          canvas.style.marginTop = oldMarginTop;
          canvas.style.marginBottom = oldMarginBottom;
          document.body.style.margin = oldDocumentBodyMargin;
          document.documentElement.style.overflow = oldDocumentOverflow; // Chrome, Firefox
          document.body.scroll = oldDocumentScroll; // IE
          canvas.style.imageRendering = oldImageRendering;
          if (canvas.GLctxObject) canvas.GLctxObject.GLctx.viewport(0, 0, oldWidth, oldHeight);
  
          if (currentFullscreenStrategy.canvasResizedCallback) {
            if (currentFullscreenStrategy.canvasResizedCallbackTargetThread) __emscripten_run_callback_on_thread(currentFullscreenStrategy.canvasResizedCallbackTargetThread, currentFullscreenStrategy.canvasResizedCallback, 37, 0, currentFullscreenStrategy.canvasResizedCallbackUserData);
            else
            getWasmTableEntry(currentFullscreenStrategy.canvasResizedCallback)(37, 0, currentFullscreenStrategy.canvasResizedCallbackUserData);
          }
        }
      }
      document.addEventListener('fullscreenchange', restoreOldStyle);
      // Unprefixed Fullscreen API shipped in Chromium 71 (https://bugs.chromium.org/p/chromium/issues/detail?id=383813)
      // As of Safari 13.0.3 on macOS Catalina 10.15.1 still ships with prefixed webkitfullscreenchange. TODO: revisit this check once Safari ships unprefixed version.
      document.addEventListener('webkitfullscreenchange', restoreOldStyle);
      return restoreOldStyle;
    };
  
  
  var setLetterbox = (element, topBottom, leftRight) => {
      // Cannot use margin to specify letterboxes in FF or Chrome, since those ignore margins in fullscreen mode.
      element.style.paddingLeft = element.style.paddingRight = leftRight + 'px';
      element.style.paddingTop = element.style.paddingBottom = topBottom + 'px';
    };
  
  
  /** @type {Object} */
  var specialHTMLTargets = [0, typeof document != 'undefined' ? document : 0, typeof window != 'undefined' ? window : 0];
  var getBoundingClientRect = (e) => specialHTMLTargets.indexOf(e) < 0 ? e.getBoundingClientRect() : {'left':0,'top':0};
  var JSEvents_resizeCanvasForFullscreen = (target, strategy) => {
      var restoreOldStyle = registerRestoreOldStyle(target);
      var cssWidth = strategy.softFullscreen ? innerWidth : screen.width;
      var cssHeight = strategy.softFullscreen ? innerHeight : screen.height;
      var rect = getBoundingClientRect(target);
      var windowedCssWidth = rect.width;
      var windowedCssHeight = rect.height;
      var canvasSize = getCanvasElementSize(target);
      var windowedRttWidth = canvasSize[0];
      var windowedRttHeight = canvasSize[1];
  
      if (strategy.scaleMode == 3) {
        setLetterbox(target, (cssHeight - windowedCssHeight) / 2, (cssWidth - windowedCssWidth) / 2);
        cssWidth = windowedCssWidth;
        cssHeight = windowedCssHeight;
      } else if (strategy.scaleMode == 2) {
        if (cssWidth*windowedRttHeight < windowedRttWidth*cssHeight) {
          var desiredCssHeight = windowedRttHeight * cssWidth / windowedRttWidth;
          setLetterbox(target, (cssHeight - desiredCssHeight) / 2, 0);
          cssHeight = desiredCssHeight;
        } else {
          var desiredCssWidth = windowedRttWidth * cssHeight / windowedRttHeight;
          setLetterbox(target, 0, (cssWidth - desiredCssWidth) / 2);
          cssWidth = desiredCssWidth;
        }
      }
  
      // If we are adding padding, must choose a background color or otherwise Chrome will give the
      // padding a default white color. Do it only if user has not customized their own background color.
      if (!target.style.backgroundColor) target.style.backgroundColor = 'black';
      // IE11 does the same, but requires the color to be set in the document body.
      if (!document.body.style.backgroundColor) document.body.style.backgroundColor = 'black'; // IE11
      // Firefox always shows black letterboxes independent of style color.
  
      target.style.width = cssWidth + 'px';
      target.style.height = cssHeight + 'px';
  
      if (strategy.filteringMode == 1) {
        target.style.imageRendering = 'optimizeSpeed';
        target.style.imageRendering = '-moz-crisp-edges';
        target.style.imageRendering = '-o-crisp-edges';
        target.style.imageRendering = '-webkit-optimize-contrast';
        target.style.imageRendering = 'optimize-contrast';
        target.style.imageRendering = 'crisp-edges';
        target.style.imageRendering = 'pixelated';
      }
  
      var dpiScale = (strategy.canvasResolutionScaleMode == 2) ? devicePixelRatio : 1;
      if (strategy.canvasResolutionScaleMode != 0) {
        var newWidth = (cssWidth * dpiScale)|0;
        var newHeight = (cssHeight * dpiScale)|0;
        setCanvasElementSize(target, newWidth, newHeight);
        if (target.GLctxObject) target.GLctxObject.GLctx.viewport(0, 0, newWidth, newHeight);
      }
      return restoreOldStyle;
    };
  
  var JSEvents_requestFullscreen = (target, strategy) => {
      // EMSCRIPTEN_FULLSCREEN_SCALE_DEFAULT + EMSCRIPTEN_FULLSCREEN_CANVAS_SCALE_NONE is a mode where no extra logic is performed to the DOM elements.
      if (strategy.scaleMode != 0 || strategy.canvasResolutionScaleMode != 0) {
        JSEvents_resizeCanvasForFullscreen(target, strategy);
      }
  
      if (target.requestFullscreen) {
        target.requestFullscreen();
      } else if (target.webkitRequestFullscreen) {
        target.webkitRequestFullscreen(Element.ALLOW_KEYBOARD_INPUT);
      } else {
        return JSEvents.fullscreenEnabled() ? -3 : -1;
      }
  
      currentFullscreenStrategy = strategy;
  
      if (strategy.canvasResizedCallback) {
        if (strategy.canvasResizedCallbackTargetThread) __emscripten_run_callback_on_thread(strategy.canvasResizedCallbackTargetThread, strategy.canvasResizedCallback, 37, 0, strategy.canvasResizedCallbackUserData);
        else
        getWasmTableEntry(strategy.canvasResizedCallback)(37, 0, strategy.canvasResizedCallbackUserData);
      }
  
      return 0;
    };
  
  
  
  function _emscripten_exit_fullscreen() {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(36, 0, 1);
  
      if (!JSEvents.fullscreenEnabled()) return -1;
      // Make sure no queued up calls will fire after this.
      JSEvents.removeDeferredCalls(JSEvents_requestFullscreen);
  
      var d = specialHTMLTargets[1];
      if (d.exitFullscreen) {
        d.fullscreenElement && d.exitFullscreen();
      } else if (d.webkitExitFullscreen) {
        d.webkitFullscreenElement && d.webkitExitFullscreen();
      } else {
        return -1;
      }
  
      return 0;
    
  }
  

  
  var requestPointerLock = (target) => {
      if (target.requestPointerLock) {
        target.requestPointerLock();
      } else {
        // document.body is known to accept pointer lock, so use that to differentiate if the user passed a bad element,
        // or if the whole browser just doesn't support the feature.
        if (document.body.requestPointerLock
          ) {
          return -3;
        }
        return -1;
      }
      return 0;
    };
  
  
  function _emscripten_exit_pointerlock() {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(38, 0, 1);
  
      // Make sure no queued up calls will fire after this.
      JSEvents.removeDeferredCalls(requestPointerLock);
  
      if (document.exitPointerLock) {
        document.exitPointerLock();
      } else {
        return -1;
      }
      return 0;
    
  }
  

  var _emscripten_exit_with_live_runtime = () => {
      runtimeKeepalivePush();
      throw 'unwind';
    };

  
  
  
  
  function _emscripten_force_exit(status) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(39, 0, 1, status);
  
      __emscripten_runtime_keepalive_clear();
      _exit(status);
    
  }
  
  Module['_emscripten_force_exit'] = _emscripten_force_exit;

  var fillBatteryEventData = (eventStruct, e) => {
      HEAPF64[((eventStruct)>>3)] = e.chargingTime;
      HEAPF64[(((eventStruct)+(8))>>3)] = e.dischargingTime;
      HEAPF64[(((eventStruct)+(16))>>3)] = e.level;
      HEAP32[(((eventStruct)+(24))>>2)] = e.charging;
    };
  
  var battery = () => navigator.battery || navigator.mozBattery || navigator.webkitBattery;
  
  
  function _emscripten_get_battery_status(batteryState) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(40, 0, 1, batteryState);
  
      if (!battery()) return -1;
      fillBatteryEventData(batteryState, battery());
      return 0;
    
  }
  

  
  function _emscripten_get_device_pixel_ratio() {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(41, 0, 1);
  
      return (typeof devicePixelRatio == 'number' && devicePixelRatio) || 1.0;
    
  }
  

  
  
  var findEventTarget = (target) => {
      target = maybeCStringToJsString(target);
      var domElement = specialHTMLTargets[target] || (typeof document != 'undefined' ? document.querySelector(target) : undefined);
      return domElement;
    };
  
  
  
  function _emscripten_get_element_css_size(target, width, height) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(42, 0, 1, target, width, height);
  
      target = findEventTarget(target);
      if (!target) return -4;
  
      var rect = getBoundingClientRect(target);
      HEAPF64[((width)>>3)] = rect.width;
      HEAPF64[((height)>>3)] = rect.height;
  
      return 0;
    
  }
  

  
  
  var fillFullscreenChangeEventData = (eventStruct) => {
      var fullscreenElement = document.fullscreenElement || document.mozFullScreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
      var isFullscreen = !!fullscreenElement;
      // Assigning a boolean to HEAP32 with expected type coercion.
      /** @suppress{checkTypes} */
      HEAP32[((eventStruct)>>2)] = isFullscreen;
      HEAP32[(((eventStruct)+(4))>>2)] = JSEvents.fullscreenEnabled();
      // If transitioning to fullscreen, report info about the element that is now fullscreen.
      // If transitioning to windowed mode, report info about the element that just was fullscreen.
      var reportedElement = isFullscreen ? fullscreenElement : JSEvents.previousFullscreenElement;
      var nodeName = JSEvents.getNodeNameForTarget(reportedElement);
      var id = reportedElement?.id || '';
      stringToUTF8(nodeName, eventStruct + 8, 128);
      stringToUTF8(id, eventStruct + 136, 128);
      HEAP32[(((eventStruct)+(264))>>2)] = reportedElement ? reportedElement.clientWidth : 0;
      HEAP32[(((eventStruct)+(268))>>2)] = reportedElement ? reportedElement.clientHeight : 0;
      HEAP32[(((eventStruct)+(272))>>2)] = screen.width;
      HEAP32[(((eventStruct)+(276))>>2)] = screen.height;
      if (isFullscreen) {
        JSEvents.previousFullscreenElement = fullscreenElement;
      }
    };
  
  
  function _emscripten_get_fullscreen_status(fullscreenStatus) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(43, 0, 1, fullscreenStatus);
  
      if (!JSEvents.fullscreenEnabled()) return -1;
      fillFullscreenChangeEventData(fullscreenStatus);
      return 0;
    
  }
  

  
  var fillGamepadEventData = (eventStruct, e) => {
      HEAPF64[((eventStruct)>>3)] = e.timestamp;
      for (var i = 0; i < e.axes.length; ++i) {
        HEAPF64[(((eventStruct+i*8)+(16))>>3)] = e.axes[i];
      }
      for (var i = 0; i < e.buttons.length; ++i) {
        if (typeof e.buttons[i] == 'object') {
          HEAPF64[(((eventStruct+i*8)+(528))>>3)] = e.buttons[i].value;
        } else {
          HEAPF64[(((eventStruct+i*8)+(528))>>3)] = e.buttons[i];
        }
      }
      for (var i = 0; i < e.buttons.length; ++i) {
        if (typeof e.buttons[i] == 'object') {
          HEAP32[(((eventStruct+i*4)+(1040))>>2)] = e.buttons[i].pressed;
        } else {
          // Assigning a boolean to HEAP32, that's ok, but Closure would like to warn about it:
          /** @suppress {checkTypes} */
          HEAP32[(((eventStruct+i*4)+(1040))>>2)] = e.buttons[i] == 1;
        }
      }
      HEAP32[(((eventStruct)+(1296))>>2)] = e.connected;
      HEAP32[(((eventStruct)+(1300))>>2)] = e.index;
      HEAP32[(((eventStruct)+(8))>>2)] = e.axes.length;
      HEAP32[(((eventStruct)+(12))>>2)] = e.buttons.length;
      stringToUTF8(e.id, eventStruct + 1304, 64);
      stringToUTF8(e.mapping, eventStruct + 1368, 64);
    };
  
  
  function _emscripten_get_gamepad_status(index, gamepadState) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(44, 0, 1, index, gamepadState);
  
      // INVALID_PARAM is returned on a Gamepad index that never was there.
      if (index < 0 || index >= JSEvents.lastGamepadState.length) return -5;
  
      // NO_DATA is returned on a Gamepad index that was removed.
      // For previously disconnected gamepads there should be an empty slot (null/undefined/false) at the index.
      // This is because gamepads must keep their original position in the array.
      // For example, removing the first of two gamepads produces [null/undefined/false, gamepad].
      if (!JSEvents.lastGamepadState[index]) return -7;
  
      fillGamepadEventData(gamepadState, JSEvents.lastGamepadState[index]);
      return 0;
    
  }
  

  var getHeapMax = () =>
      HEAPU8.length;
  var _emscripten_get_heap_max = () => getHeapMax();

  var _emscripten_get_main_loop_timing = (mode, value) => {
      if (mode) HEAP32[((mode)>>2)] = Browser.mainLoop.timingMode;
      if (value) HEAP32[((value)>>2)] = Browser.mainLoop.timingValue;
    };


  var _emscripten_get_now_res = () => { // return resolution of get_now, in nanoseconds
      if (ENVIRONMENT_IS_NODE) {
        return 1; // nanoseconds
      }
      // Modern environment where performance.now() is supported:
      return 1000; // microseconds (1/1000 of a millisecond)
    };

  
  
  function _emscripten_get_num_gamepads() {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(45, 0, 1);
  
      // N.B. Do not call emscripten_get_num_gamepads() unless having first called emscripten_sample_gamepad_data(), and that has returned EMSCRIPTEN_RESULT_SUCCESS.
      // Otherwise the following line will throw an exception.
      return JSEvents.lastGamepadState.length;
    
  }
  

  
  
  function _emscripten_get_screen_size(width, height) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(46, 0, 1, width, height);
  
      HEAP32[((width)>>2)] = screen.width;
      HEAP32[((height)>>2)] = screen.height;
    
  }
  

  /** @suppress {duplicate } */
  var _glActiveTexture = (x0) => GLctx.activeTexture(x0);
  var _emscripten_glActiveTexture = _glActiveTexture;

  /** @suppress {duplicate } */
  var _glAttachShader = (program, shader) => {
      GLctx.attachShader(GL.programs[program], GL.shaders[shader]);
    };
  var _emscripten_glAttachShader = _glAttachShader;

  /** @suppress {duplicate } */
  var _glBeginQuery = (target, id) => {
      GLctx.beginQuery(target, GL.queries[id]);
    };
  var _emscripten_glBeginQuery = _glBeginQuery;

  /** @suppress {duplicate } */
  var _glBeginQueryEXT = (target, id) => {
      GLctx.disjointTimerQueryExt['beginQueryEXT'](target, GL.queries[id]);
    };
  var _emscripten_glBeginQueryEXT = _glBeginQueryEXT;

  /** @suppress {duplicate } */
  var _glBeginTransformFeedback = (x0) => GLctx.beginTransformFeedback(x0);
  var _emscripten_glBeginTransformFeedback = _glBeginTransformFeedback;

  
  /** @suppress {duplicate } */
  var _glBindAttribLocation = (program, index, name) => {
      GLctx.bindAttribLocation(GL.programs[program], index, UTF8ToString(name));
    };
  var _emscripten_glBindAttribLocation = _glBindAttribLocation;

  /** @suppress {duplicate } */
  var _glBindBuffer = (target, buffer) => {
  
      if (target == 0x88EB /*GL_PIXEL_PACK_BUFFER*/) {
        // In WebGL 2 glReadPixels entry point, we need to use a different WebGL 2
        // API function call when a buffer is bound to
        // GL_PIXEL_PACK_BUFFER_BINDING point, so must keep track whether that
        // binding point is non-null to know what is the proper API function to
        // call.
        GLctx.currentPixelPackBufferBinding = buffer;
      } else if (target == 0x88EC /*GL_PIXEL_UNPACK_BUFFER*/) {
        // In WebGL 2 gl(Compressed)Tex(Sub)Image[23]D entry points, we need to
        // use a different WebGL 2 API function call when a buffer is bound to
        // GL_PIXEL_UNPACK_BUFFER_BINDING point, so must keep track whether that
        // binding point is non-null to know what is the proper API function to
        // call.
        GLctx.currentPixelUnpackBufferBinding = buffer;
      }
      GLctx.bindBuffer(target, GL.buffers[buffer]);
    };
  var _emscripten_glBindBuffer = _glBindBuffer;

  /** @suppress {duplicate } */
  var _glBindBufferBase = (target, index, buffer) => {
      GLctx.bindBufferBase(target, index, GL.buffers[buffer]);
    };
  var _emscripten_glBindBufferBase = _glBindBufferBase;

  /** @suppress {duplicate } */
  var _glBindBufferRange = (target, index, buffer, offset, ptrsize) => {
      GLctx.bindBufferRange(target, index, GL.buffers[buffer], offset, ptrsize);
    };
  var _emscripten_glBindBufferRange = _glBindBufferRange;

  /** @suppress {duplicate } */
  var _glBindFramebuffer = (target, framebuffer) => {
  
      GLctx.bindFramebuffer(target, GL.framebuffers[framebuffer]);
  
    };
  var _emscripten_glBindFramebuffer = _glBindFramebuffer;

  /** @suppress {duplicate } */
  var _glBindRenderbuffer = (target, renderbuffer) => {
      GLctx.bindRenderbuffer(target, GL.renderbuffers[renderbuffer]);
    };
  var _emscripten_glBindRenderbuffer = _glBindRenderbuffer;

  /** @suppress {duplicate } */
  var _glBindSampler = (unit, sampler) => {
      GLctx.bindSampler(unit, GL.samplers[sampler]);
    };
  var _emscripten_glBindSampler = _glBindSampler;

  /** @suppress {duplicate } */
  var _glBindTexture = (target, texture) => {
      GLctx.bindTexture(target, GL.textures[texture]);
    };
  var _emscripten_glBindTexture = _glBindTexture;

  /** @suppress {duplicate } */
  var _glBindTransformFeedback = (target, id) => {
      GLctx.bindTransformFeedback(target, GL.transformFeedbacks[id]);
    };
  var _emscripten_glBindTransformFeedback = _glBindTransformFeedback;

  /** @suppress {duplicate } */
  var _glBindVertexArray = (vao) => {
      GLctx.bindVertexArray(GL.vaos[vao]);
    };
  var _emscripten_glBindVertexArray = _glBindVertexArray;

  
  /** @suppress {duplicate } */
  var _glBindVertexArrayOES = _glBindVertexArray;
  var _emscripten_glBindVertexArrayOES = _glBindVertexArrayOES;

  /** @suppress {duplicate } */
  var _glBlendColor = (x0, x1, x2, x3) => GLctx.blendColor(x0, x1, x2, x3);
  var _emscripten_glBlendColor = _glBlendColor;

  /** @suppress {duplicate } */
  var _glBlendEquation = (x0) => GLctx.blendEquation(x0);
  var _emscripten_glBlendEquation = _glBlendEquation;

  /** @suppress {duplicate } */
  var _glBlendEquationSeparate = (x0, x1) => GLctx.blendEquationSeparate(x0, x1);
  var _emscripten_glBlendEquationSeparate = _glBlendEquationSeparate;

  /** @suppress {duplicate } */
  var _glBlendFunc = (x0, x1) => GLctx.blendFunc(x0, x1);
  var _emscripten_glBlendFunc = _glBlendFunc;

  /** @suppress {duplicate } */
  var _glBlendFuncSeparate = (x0, x1, x2, x3) => GLctx.blendFuncSeparate(x0, x1, x2, x3);
  var _emscripten_glBlendFuncSeparate = _glBlendFuncSeparate;

  /** @suppress {duplicate } */
  var _glBlitFramebuffer = (x0, x1, x2, x3, x4, x5, x6, x7, x8, x9) => GLctx.blitFramebuffer(x0, x1, x2, x3, x4, x5, x6, x7, x8, x9);
  var _emscripten_glBlitFramebuffer = _glBlitFramebuffer;

  /** @suppress {duplicate } */
  var _glBufferData = (target, size, data, usage) => {
  
      if (true) {
        // If size is zero, WebGL would interpret uploading the whole input
        // arraybuffer (starting from given offset), which would not make sense in
        // WebAssembly, so avoid uploading if size is zero. However we must still
        // call bufferData to establish a backing storage of zero bytes.
        if (data && size) {
          GLctx.bufferData(target, HEAPU8, usage, data, size);
        } else {
          GLctx.bufferData(target, size, usage);
        }
        return;
      }
      // N.b. here first form specifies a heap subarray, second form an integer
      // size, so the ?: code here is polymorphic. It is advised to avoid
      // randomly mixing both uses in calling code, to avoid any potential JS
      // engine JIT issues.
      GLctx.bufferData(target, data ? HEAPU8.subarray(data, data+size) : size, usage);
    };
  var _emscripten_glBufferData = _glBufferData;

  /** @suppress {duplicate } */
  var _glBufferSubData = (target, offset, size, data) => {
      if (true) {
        size && GLctx.bufferSubData(target, offset, HEAPU8, data, size);
        return;
      }
      GLctx.bufferSubData(target, offset, HEAPU8.subarray(data, data+size));
    };
  var _emscripten_glBufferSubData = _glBufferSubData;

  /** @suppress {duplicate } */
  var _glCheckFramebufferStatus = (x0) => GLctx.checkFramebufferStatus(x0);
  var _emscripten_glCheckFramebufferStatus = _glCheckFramebufferStatus;

  /** @suppress {duplicate } */
  var _glClear = (x0) => GLctx.clear(x0);
  var _emscripten_glClear = _glClear;

  /** @suppress {duplicate } */
  var _glClearBufferfi = (x0, x1, x2, x3) => GLctx.clearBufferfi(x0, x1, x2, x3);
  var _emscripten_glClearBufferfi = _glClearBufferfi;

  /** @suppress {duplicate } */
  var _glClearBufferfv = (buffer, drawbuffer, value) => {
  
      GLctx.clearBufferfv(buffer, drawbuffer, HEAPF32, ((value)>>2));
    };
  var _emscripten_glClearBufferfv = _glClearBufferfv;

  /** @suppress {duplicate } */
  var _glClearBufferiv = (buffer, drawbuffer, value) => {
  
      GLctx.clearBufferiv(buffer, drawbuffer, HEAP32, ((value)>>2));
    };
  var _emscripten_glClearBufferiv = _glClearBufferiv;

  /** @suppress {duplicate } */
  var _glClearBufferuiv = (buffer, drawbuffer, value) => {
  
      GLctx.clearBufferuiv(buffer, drawbuffer, HEAPU32, ((value)>>2));
    };
  var _emscripten_glClearBufferuiv = _glClearBufferuiv;

  /** @suppress {duplicate } */
  var _glClearColor = (x0, x1, x2, x3) => GLctx.clearColor(x0, x1, x2, x3);
  var _emscripten_glClearColor = _glClearColor;

  /** @suppress {duplicate } */
  var _glClearDepthf = (x0) => GLctx.clearDepth(x0);
  var _emscripten_glClearDepthf = _glClearDepthf;

  /** @suppress {duplicate } */
  var _glClearStencil = (x0) => GLctx.clearStencil(x0);
  var _emscripten_glClearStencil = _glClearStencil;

  /** @suppress {duplicate } */
  var _glClientWaitSync = (sync, flags, timeout) => {
      // WebGL2 vs GLES3 differences: in GLES3, the timeout parameter is a uint64, where 0xFFFFFFFFFFFFFFFFULL means GL_TIMEOUT_IGNORED.
      // In JS, there's no 64-bit value types, so instead timeout is taken to be signed, and GL_TIMEOUT_IGNORED is given value -1.
      // Inherently the value accepted in the timeout is lossy, and can't take in arbitrary u64 bit pattern (but most likely doesn't matter)
      // See https://www.khronos.org/registry/webgl/specs/latest/2.0/#5.15
      timeout = Number(timeout);
      return GLctx.clientWaitSync(GL.syncs[sync], flags, timeout);
    };
  var _emscripten_glClientWaitSync = _glClientWaitSync;

  /** @suppress {duplicate } */
  var _glColorMask = (red, green, blue, alpha) => {
      GLctx.colorMask(!!red, !!green, !!blue, !!alpha);
    };
  var _emscripten_glColorMask = _glColorMask;

  /** @suppress {duplicate } */
  var _glCompileShader = (shader) => {
      GLctx.compileShader(GL.shaders[shader]);
    };
  var _emscripten_glCompileShader = _glCompileShader;

  /** @suppress {duplicate } */
  var _glCompressedTexImage2D = (target, level, internalFormat, width, height, border, imageSize, data) => {
      if (true) {
        if (GLctx.currentPixelUnpackBufferBinding || !imageSize) {
          GLctx.compressedTexImage2D(target, level, internalFormat, width, height, border, imageSize, data);
          return;
        }
        GLctx.compressedTexImage2D(target, level, internalFormat, width, height, border, HEAPU8, data, imageSize);
        return;
      }
      GLctx.compressedTexImage2D(target, level, internalFormat, width, height, border, data ? HEAPU8.subarray((data), data+imageSize) : null);
    };
  var _emscripten_glCompressedTexImage2D = _glCompressedTexImage2D;

  /** @suppress {duplicate } */
  var _glCompressedTexImage3D = (target, level, internalFormat, width, height, depth, border, imageSize, data) => {
      if (GLctx.currentPixelUnpackBufferBinding) {
        GLctx.compressedTexImage3D(target, level, internalFormat, width, height, depth, border, imageSize, data);
      } else {
        GLctx.compressedTexImage3D(target, level, internalFormat, width, height, depth, border, HEAPU8, data, imageSize);
      }
    };
  var _emscripten_glCompressedTexImage3D = _glCompressedTexImage3D;

  /** @suppress {duplicate } */
  var _glCompressedTexSubImage2D = (target, level, xoffset, yoffset, width, height, format, imageSize, data) => {
      if (true) {
        if (GLctx.currentPixelUnpackBufferBinding || !imageSize) {
          GLctx.compressedTexSubImage2D(target, level, xoffset, yoffset, width, height, format, imageSize, data);
          return;
        }
        GLctx.compressedTexSubImage2D(target, level, xoffset, yoffset, width, height, format, HEAPU8, data, imageSize);
        return;
      }
      GLctx.compressedTexSubImage2D(target, level, xoffset, yoffset, width, height, format, data ? HEAPU8.subarray((data), data+imageSize) : null);
    };
  var _emscripten_glCompressedTexSubImage2D = _glCompressedTexSubImage2D;

  /** @suppress {duplicate } */
  var _glCompressedTexSubImage3D = (target, level, xoffset, yoffset, zoffset, width, height, depth, format, imageSize, data) => {
      if (GLctx.currentPixelUnpackBufferBinding) {
        GLctx.compressedTexSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, imageSize, data);
      } else {
        GLctx.compressedTexSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, HEAPU8, data, imageSize);
      }
    };
  var _emscripten_glCompressedTexSubImage3D = _glCompressedTexSubImage3D;

  /** @suppress {duplicate } */
  var _glCopyBufferSubData = (x0, x1, x2, x3, x4) => GLctx.copyBufferSubData(x0, x1, x2, x3, x4);
  var _emscripten_glCopyBufferSubData = _glCopyBufferSubData;

  /** @suppress {duplicate } */
  var _glCopyTexImage2D = (x0, x1, x2, x3, x4, x5, x6, x7) => GLctx.copyTexImage2D(x0, x1, x2, x3, x4, x5, x6, x7);
  var _emscripten_glCopyTexImage2D = _glCopyTexImage2D;

  /** @suppress {duplicate } */
  var _glCopyTexSubImage2D = (x0, x1, x2, x3, x4, x5, x6, x7) => GLctx.copyTexSubImage2D(x0, x1, x2, x3, x4, x5, x6, x7);
  var _emscripten_glCopyTexSubImage2D = _glCopyTexSubImage2D;

  /** @suppress {duplicate } */
  var _glCopyTexSubImage3D = (x0, x1, x2, x3, x4, x5, x6, x7, x8) => GLctx.copyTexSubImage3D(x0, x1, x2, x3, x4, x5, x6, x7, x8);
  var _emscripten_glCopyTexSubImage3D = _glCopyTexSubImage3D;

  /** @suppress {duplicate } */
  var _glCreateProgram = () => {
      var id = GL.getNewId(GL.programs);
      var program = GLctx.createProgram();
      // Store additional information needed for each shader program:
      program.name = id;
      // Lazy cache results of
      // glGetProgramiv(GL_ACTIVE_UNIFORM_MAX_LENGTH/GL_ACTIVE_ATTRIBUTE_MAX_LENGTH/GL_ACTIVE_UNIFORM_BLOCK_MAX_NAME_LENGTH)
      program.maxUniformLength = program.maxAttributeLength = program.maxUniformBlockNameLength = 0;
      program.uniformIdCounter = 1;
      GL.programs[id] = program;
      return id;
    };
  var _emscripten_glCreateProgram = _glCreateProgram;

  /** @suppress {duplicate } */
  var _glCreateShader = (shaderType) => {
      var id = GL.getNewId(GL.shaders);
      GL.shaders[id] = GLctx.createShader(shaderType);
  
      return id;
    };
  var _emscripten_glCreateShader = _glCreateShader;

  /** @suppress {duplicate } */
  var _glCullFace = (x0) => GLctx.cullFace(x0);
  var _emscripten_glCullFace = _glCullFace;

  /** @suppress {duplicate } */
  var _glDeleteBuffers = (n, buffers) => {
      for (var i = 0; i < n; i++) {
        var id = HEAP32[(((buffers)+(i*4))>>2)];
        var buffer = GL.buffers[id];
  
        // From spec: "glDeleteBuffers silently ignores 0's and names that do not
        // correspond to existing buffer objects."
        if (!buffer) continue;
  
        GLctx.deleteBuffer(buffer);
        buffer.name = 0;
        GL.buffers[id] = null;
  
        if (id == GLctx.currentPixelPackBufferBinding) GLctx.currentPixelPackBufferBinding = 0;
        if (id == GLctx.currentPixelUnpackBufferBinding) GLctx.currentPixelUnpackBufferBinding = 0;
      }
    };
  var _emscripten_glDeleteBuffers = _glDeleteBuffers;

  /** @suppress {duplicate } */
  var _glDeleteFramebuffers = (n, framebuffers) => {
      for (var i = 0; i < n; ++i) {
        var id = HEAP32[(((framebuffers)+(i*4))>>2)];
        var framebuffer = GL.framebuffers[id];
        if (!framebuffer) continue; // GL spec: "glDeleteFramebuffers silently ignores 0s and names that do not correspond to existing framebuffer objects".
        GLctx.deleteFramebuffer(framebuffer);
        framebuffer.name = 0;
        GL.framebuffers[id] = null;
      }
    };
  var _emscripten_glDeleteFramebuffers = _glDeleteFramebuffers;

  /** @suppress {duplicate } */
  var _glDeleteProgram = (id) => {
      if (!id) return;
      var program = GL.programs[id];
      if (!program) {
        // glDeleteProgram actually signals an error when deleting a nonexisting
        // object, unlike some other GL delete functions.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      GLctx.deleteProgram(program);
      program.name = 0;
      GL.programs[id] = null;
    };
  var _emscripten_glDeleteProgram = _glDeleteProgram;

  /** @suppress {duplicate } */
  var _glDeleteQueries = (n, ids) => {
      for (var i = 0; i < n; i++) {
        var id = HEAP32[(((ids)+(i*4))>>2)];
        var query = GL.queries[id];
        if (!query) continue; // GL spec: "unused names in ids are ignored, as is the name zero."
        GLctx.deleteQuery(query);
        GL.queries[id] = null;
      }
    };
  var _emscripten_glDeleteQueries = _glDeleteQueries;

  /** @suppress {duplicate } */
  var _glDeleteQueriesEXT = (n, ids) => {
      for (var i = 0; i < n; i++) {
        var id = HEAP32[(((ids)+(i*4))>>2)];
        var query = GL.queries[id];
        if (!query) continue; // GL spec: "unused names in ids are ignored, as is the name zero."
        GLctx.disjointTimerQueryExt['deleteQueryEXT'](query);
        GL.queries[id] = null;
      }
    };
  var _emscripten_glDeleteQueriesEXT = _glDeleteQueriesEXT;

  /** @suppress {duplicate } */
  var _glDeleteRenderbuffers = (n, renderbuffers) => {
      for (var i = 0; i < n; i++) {
        var id = HEAP32[(((renderbuffers)+(i*4))>>2)];
        var renderbuffer = GL.renderbuffers[id];
        if (!renderbuffer) continue; // GL spec: "glDeleteRenderbuffers silently ignores 0s and names that do not correspond to existing renderbuffer objects".
        GLctx.deleteRenderbuffer(renderbuffer);
        renderbuffer.name = 0;
        GL.renderbuffers[id] = null;
      }
    };
  var _emscripten_glDeleteRenderbuffers = _glDeleteRenderbuffers;

  /** @suppress {duplicate } */
  var _glDeleteSamplers = (n, samplers) => {
      for (var i = 0; i < n; i++) {
        var id = HEAP32[(((samplers)+(i*4))>>2)];
        var sampler = GL.samplers[id];
        if (!sampler) continue;
        GLctx.deleteSampler(sampler);
        sampler.name = 0;
        GL.samplers[id] = null;
      }
    };
  var _emscripten_glDeleteSamplers = _glDeleteSamplers;

  /** @suppress {duplicate } */
  var _glDeleteShader = (id) => {
      if (!id) return;
      var shader = GL.shaders[id];
      if (!shader) {
        // glDeleteShader actually signals an error when deleting a nonexisting
        // object, unlike some other GL delete functions.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      GLctx.deleteShader(shader);
      GL.shaders[id] = null;
    };
  var _emscripten_glDeleteShader = _glDeleteShader;

  /** @suppress {duplicate } */
  var _glDeleteSync = (id) => {
      if (!id) return;
      var sync = GL.syncs[id];
      if (!sync) { // glDeleteSync signals an error when deleting a nonexisting object, unlike some other GL delete functions.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      GLctx.deleteSync(sync);
      sync.name = 0;
      GL.syncs[id] = null;
    };
  var _emscripten_glDeleteSync = _glDeleteSync;

  /** @suppress {duplicate } */
  var _glDeleteTextures = (n, textures) => {
      for (var i = 0; i < n; i++) {
        var id = HEAP32[(((textures)+(i*4))>>2)];
        var texture = GL.textures[id];
        // GL spec: "glDeleteTextures silently ignores 0s and names that do not
        // correspond to existing textures".
        if (!texture) continue;
        GLctx.deleteTexture(texture);
        texture.name = 0;
        GL.textures[id] = null;
      }
    };
  var _emscripten_glDeleteTextures = _glDeleteTextures;

  /** @suppress {duplicate } */
  var _glDeleteTransformFeedbacks = (n, ids) => {
      for (var i = 0; i < n; i++) {
        var id = HEAP32[(((ids)+(i*4))>>2)];
        var transformFeedback = GL.transformFeedbacks[id];
        if (!transformFeedback) continue; // GL spec: "unused names in ids are ignored, as is the name zero."
        GLctx.deleteTransformFeedback(transformFeedback);
        transformFeedback.name = 0;
        GL.transformFeedbacks[id] = null;
      }
    };
  var _emscripten_glDeleteTransformFeedbacks = _glDeleteTransformFeedbacks;

  /** @suppress {duplicate } */
  var _glDeleteVertexArrays = (n, vaos) => {
      for (var i = 0; i < n; i++) {
        var id = HEAP32[(((vaos)+(i*4))>>2)];
        GLctx.deleteVertexArray(GL.vaos[id]);
        GL.vaos[id] = null;
      }
    };
  var _emscripten_glDeleteVertexArrays = _glDeleteVertexArrays;

  
  /** @suppress {duplicate } */
  var _glDeleteVertexArraysOES = _glDeleteVertexArrays;
  var _emscripten_glDeleteVertexArraysOES = _glDeleteVertexArraysOES;

  /** @suppress {duplicate } */
  var _glDepthFunc = (x0) => GLctx.depthFunc(x0);
  var _emscripten_glDepthFunc = _glDepthFunc;

  /** @suppress {duplicate } */
  var _glDepthMask = (flag) => {
      GLctx.depthMask(!!flag);
    };
  var _emscripten_glDepthMask = _glDepthMask;

  /** @suppress {duplicate } */
  var _glDepthRangef = (x0, x1) => GLctx.depthRange(x0, x1);
  var _emscripten_glDepthRangef = _glDepthRangef;

  /** @suppress {duplicate } */
  var _glDetachShader = (program, shader) => {
      GLctx.detachShader(GL.programs[program], GL.shaders[shader]);
    };
  var _emscripten_glDetachShader = _glDetachShader;

  /** @suppress {duplicate } */
  var _glDisable = (x0) => GLctx.disable(x0);
  var _emscripten_glDisable = _glDisable;

  /** @suppress {duplicate } */
  var _glDisableVertexAttribArray = (index) => {
      GLctx.disableVertexAttribArray(index);
    };
  var _emscripten_glDisableVertexAttribArray = _glDisableVertexAttribArray;

  /** @suppress {duplicate } */
  var _glDrawArrays = (mode, first, count) => {
  
      GLctx.drawArrays(mode, first, count);
  
    };
  var _emscripten_glDrawArrays = _glDrawArrays;

  /** @suppress {duplicate } */
  var _glDrawArraysInstanced = (mode, first, count, primcount) => {
      GLctx.drawArraysInstanced(mode, first, count, primcount);
    };
  var _emscripten_glDrawArraysInstanced = _glDrawArraysInstanced;

  
  /** @suppress {duplicate } */
  var _glDrawArraysInstancedANGLE = _glDrawArraysInstanced;
  var _emscripten_glDrawArraysInstancedANGLE = _glDrawArraysInstancedANGLE;

  
  /** @suppress {duplicate } */
  var _glDrawArraysInstancedARB = _glDrawArraysInstanced;
  var _emscripten_glDrawArraysInstancedARB = _glDrawArraysInstancedARB;

  
  /** @suppress {duplicate } */
  var _glDrawArraysInstancedEXT = _glDrawArraysInstanced;
  var _emscripten_glDrawArraysInstancedEXT = _glDrawArraysInstancedEXT;

  
  /** @suppress {duplicate } */
  var _glDrawArraysInstancedNV = _glDrawArraysInstanced;
  var _emscripten_glDrawArraysInstancedNV = _glDrawArraysInstancedNV;

  var tempFixedLengthArray = [];
  
  /** @suppress {duplicate } */
  var _glDrawBuffers = (n, bufs) => {
  
      var bufArray = tempFixedLengthArray[n];
      for (var i = 0; i < n; i++) {
        bufArray[i] = HEAP32[(((bufs)+(i*4))>>2)];
      }
  
      GLctx.drawBuffers(bufArray);
    };
  var _emscripten_glDrawBuffers = _glDrawBuffers;

  
  /** @suppress {duplicate } */
  var _glDrawBuffersEXT = _glDrawBuffers;
  var _emscripten_glDrawBuffersEXT = _glDrawBuffersEXT;

  
  /** @suppress {duplicate } */
  var _glDrawBuffersWEBGL = _glDrawBuffers;
  var _emscripten_glDrawBuffersWEBGL = _glDrawBuffersWEBGL;

  /** @suppress {duplicate } */
  var _glDrawElements = (mode, count, type, indices) => {
  
      GLctx.drawElements(mode, count, type, indices);
  
    };
  var _emscripten_glDrawElements = _glDrawElements;

  /** @suppress {duplicate } */
  var _glDrawElementsInstanced = (mode, count, type, indices, primcount) => {
      GLctx.drawElementsInstanced(mode, count, type, indices, primcount);
    };
  var _emscripten_glDrawElementsInstanced = _glDrawElementsInstanced;

  
  /** @suppress {duplicate } */
  var _glDrawElementsInstancedANGLE = _glDrawElementsInstanced;
  var _emscripten_glDrawElementsInstancedANGLE = _glDrawElementsInstancedANGLE;

  
  /** @suppress {duplicate } */
  var _glDrawElementsInstancedARB = _glDrawElementsInstanced;
  var _emscripten_glDrawElementsInstancedARB = _glDrawElementsInstancedARB;

  
  /** @suppress {duplicate } */
  var _glDrawElementsInstancedEXT = _glDrawElementsInstanced;
  var _emscripten_glDrawElementsInstancedEXT = _glDrawElementsInstancedEXT;

  
  /** @suppress {duplicate } */
  var _glDrawElementsInstancedNV = _glDrawElementsInstanced;
  var _emscripten_glDrawElementsInstancedNV = _glDrawElementsInstancedNV;

  /** @suppress {duplicate } */
  var _glDrawRangeElements = (mode, start, end, count, type, indices) => {
      // TODO: This should be a trivial pass-though function registered at the bottom of this page as
      // glFuncs[6][1] += ' drawRangeElements';
      // but due to https://bugzilla.mozilla.org/show_bug.cgi?id=1202427,
      // we work around by ignoring the range.
      _glDrawElements(mode, count, type, indices);
    };
  var _emscripten_glDrawRangeElements = _glDrawRangeElements;

  /** @suppress {duplicate } */
  var _glEnable = (x0) => GLctx.enable(x0);
  var _emscripten_glEnable = _glEnable;

  /** @suppress {duplicate } */
  var _glEnableVertexAttribArray = (index) => {
      GLctx.enableVertexAttribArray(index);
    };
  var _emscripten_glEnableVertexAttribArray = _glEnableVertexAttribArray;

  /** @suppress {duplicate } */
  var _glEndQuery = (x0) => GLctx.endQuery(x0);
  var _emscripten_glEndQuery = _glEndQuery;

  /** @suppress {duplicate } */
  var _glEndQueryEXT = (target) => {
      GLctx.disjointTimerQueryExt['endQueryEXT'](target);
    };
  var _emscripten_glEndQueryEXT = _glEndQueryEXT;

  /** @suppress {duplicate } */
  var _glEndTransformFeedback = () => GLctx.endTransformFeedback();
  var _emscripten_glEndTransformFeedback = _glEndTransformFeedback;

  /** @suppress {duplicate } */
  var _glFenceSync = (condition, flags) => {
      var sync = GLctx.fenceSync(condition, flags);
      if (sync) {
        var id = GL.getNewId(GL.syncs);
        sync.name = id;
        GL.syncs[id] = sync;
        return id;
      }
      return 0; // Failed to create a sync object
    };
  var _emscripten_glFenceSync = _glFenceSync;

  /** @suppress {duplicate } */
  var _glFinish = () => GLctx.finish();
  var _emscripten_glFinish = _glFinish;

  /** @suppress {duplicate } */
  var _glFlush = () => GLctx.flush();
  var _emscripten_glFlush = _glFlush;

  /** @suppress {duplicate } */
  var _glFramebufferRenderbuffer = (target, attachment, renderbuffertarget, renderbuffer) => {
      GLctx.framebufferRenderbuffer(target, attachment, renderbuffertarget,
                                         GL.renderbuffers[renderbuffer]);
    };
  var _emscripten_glFramebufferRenderbuffer = _glFramebufferRenderbuffer;

  /** @suppress {duplicate } */
  var _glFramebufferTexture2D = (target, attachment, textarget, texture, level) => {
      GLctx.framebufferTexture2D(target, attachment, textarget,
                                      GL.textures[texture], level);
    };
  var _emscripten_glFramebufferTexture2D = _glFramebufferTexture2D;

  /** @suppress {duplicate } */
  var _glFramebufferTextureLayer = (target, attachment, texture, level, layer) => {
      GLctx.framebufferTextureLayer(target, attachment, GL.textures[texture], level, layer);
    };
  var _emscripten_glFramebufferTextureLayer = _glFramebufferTextureLayer;

  /** @suppress {duplicate } */
  var _glFrontFace = (x0) => GLctx.frontFace(x0);
  var _emscripten_glFrontFace = _glFrontFace;

  /** @suppress {duplicate } */
  var _glGenBuffers = (n, buffers) => {
      GL.genObject(n, buffers, 'createBuffer', GL.buffers
        );
    };
  var _emscripten_glGenBuffers = _glGenBuffers;

  /** @suppress {duplicate } */
  var _glGenFramebuffers = (n, ids) => {
      GL.genObject(n, ids, 'createFramebuffer', GL.framebuffers
        );
    };
  var _emscripten_glGenFramebuffers = _glGenFramebuffers;

  /** @suppress {duplicate } */
  var _glGenQueries = (n, ids) => {
      GL.genObject(n, ids, 'createQuery', GL.queries
        );
    };
  var _emscripten_glGenQueries = _glGenQueries;

  /** @suppress {duplicate } */
  var _glGenQueriesEXT = (n, ids) => {
      for (var i = 0; i < n; i++) {
        var query = GLctx.disjointTimerQueryExt['createQueryEXT']();
        if (!query) {
          GL.recordError(0x502 /* GL_INVALID_OPERATION */);
          while (i < n) HEAP32[(((ids)+(i++*4))>>2)] = 0;
          return;
        }
        var id = GL.getNewId(GL.queries);
        query.name = id;
        GL.queries[id] = query;
        HEAP32[(((ids)+(i*4))>>2)] = id;
      }
    };
  var _emscripten_glGenQueriesEXT = _glGenQueriesEXT;

  /** @suppress {duplicate } */
  var _glGenRenderbuffers = (n, renderbuffers) => {
      GL.genObject(n, renderbuffers, 'createRenderbuffer', GL.renderbuffers
        );
    };
  var _emscripten_glGenRenderbuffers = _glGenRenderbuffers;

  /** @suppress {duplicate } */
  var _glGenSamplers = (n, samplers) => {
      GL.genObject(n, samplers, 'createSampler', GL.samplers
        );
    };
  var _emscripten_glGenSamplers = _glGenSamplers;

  /** @suppress {duplicate } */
  var _glGenTextures = (n, textures) => {
      GL.genObject(n, textures, 'createTexture', GL.textures
        );
    };
  var _emscripten_glGenTextures = _glGenTextures;

  /** @suppress {duplicate } */
  var _glGenTransformFeedbacks = (n, ids) => {
      GL.genObject(n, ids, 'createTransformFeedback', GL.transformFeedbacks
        );
    };
  var _emscripten_glGenTransformFeedbacks = _glGenTransformFeedbacks;

  /** @suppress {duplicate } */
  var _glGenVertexArrays = (n, arrays) => {
      GL.genObject(n, arrays, 'createVertexArray', GL.vaos
        );
    };
  var _emscripten_glGenVertexArrays = _glGenVertexArrays;

  
  /** @suppress {duplicate } */
  var _glGenVertexArraysOES = _glGenVertexArrays;
  var _emscripten_glGenVertexArraysOES = _glGenVertexArraysOES;

  /** @suppress {duplicate } */
  var _glGenerateMipmap = (x0) => GLctx.generateMipmap(x0);
  var _emscripten_glGenerateMipmap = _glGenerateMipmap;

  
  var __glGetActiveAttribOrUniform = (funcName, program, index, bufSize, length, size, type, name) => {
      program = GL.programs[program];
      var info = GLctx[funcName](program, index);
      if (info) {
        // If an error occurs, nothing will be written to length, size and type and name.
        var numBytesWrittenExclNull = name && stringToUTF8(info.name, name, bufSize);
        if (length) HEAP32[((length)>>2)] = numBytesWrittenExclNull;
        if (size) HEAP32[((size)>>2)] = info.size;
        if (type) HEAP32[((type)>>2)] = info.type;
      }
    };
  
  /** @suppress {duplicate } */
  var _glGetActiveAttrib = (program, index, bufSize, length, size, type, name) => {
      __glGetActiveAttribOrUniform('getActiveAttrib', program, index, bufSize, length, size, type, name);
    };
  var _emscripten_glGetActiveAttrib = _glGetActiveAttrib;

  
  /** @suppress {duplicate } */
  var _glGetActiveUniform = (program, index, bufSize, length, size, type, name) => {
      __glGetActiveAttribOrUniform('getActiveUniform', program, index, bufSize, length, size, type, name);
    };
  var _emscripten_glGetActiveUniform = _glGetActiveUniform;

  /** @suppress {duplicate } */
  var _glGetActiveUniformBlockName = (program, uniformBlockIndex, bufSize, length, uniformBlockName) => {
      program = GL.programs[program];
  
      var result = GLctx.getActiveUniformBlockName(program, uniformBlockIndex);
      if (!result) return; // If an error occurs, nothing will be written to uniformBlockName or length.
      if (uniformBlockName && bufSize > 0) {
        var numBytesWrittenExclNull = stringToUTF8(result, uniformBlockName, bufSize);
        if (length) HEAP32[((length)>>2)] = numBytesWrittenExclNull;
      } else {
        if (length) HEAP32[((length)>>2)] = 0;
      }
    };
  var _emscripten_glGetActiveUniformBlockName = _glGetActiveUniformBlockName;

  /** @suppress {duplicate } */
  var _glGetActiveUniformBlockiv = (program, uniformBlockIndex, pname, params) => {
      if (!params) {
        // GLES2 specification does not specify how to behave if params is a null pointer. Since calling this function does not make sense
        // if params == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      program = GL.programs[program];
  
      if (pname == 0x8A41 /* GL_UNIFORM_BLOCK_NAME_LENGTH */) {
        var name = GLctx.getActiveUniformBlockName(program, uniformBlockIndex);
        HEAP32[((params)>>2)] = name.length+1;
        return;
      }
  
      var result = GLctx.getActiveUniformBlockParameter(program, uniformBlockIndex, pname);
      if (result === null) return; // If an error occurs, nothing should be written to params.
      if (pname == 0x8A43 /*GL_UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES*/) {
        for (var i = 0; i < result.length; i++) {
          HEAP32[(((params)+(i*4))>>2)] = result[i];
        }
      } else {
        HEAP32[((params)>>2)] = result;
      }
    };
  var _emscripten_glGetActiveUniformBlockiv = _glGetActiveUniformBlockiv;

  /** @suppress {duplicate } */
  var _glGetActiveUniformsiv = (program, uniformCount, uniformIndices, pname, params) => {
      if (!params) {
        // GLES2 specification does not specify how to behave if params is a null pointer. Since calling this function does not make sense
        // if params == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      if (uniformCount > 0 && uniformIndices == 0) {
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      program = GL.programs[program];
      var ids = [];
      for (var i = 0; i < uniformCount; i++) {
        ids.push(HEAP32[(((uniformIndices)+(i*4))>>2)]);
      }
  
      var result = GLctx.getActiveUniforms(program, ids, pname);
      if (!result) return; // GL spec: If an error is generated, nothing is written out to params.
  
      var len = result.length;
      for (var i = 0; i < len; i++) {
        HEAP32[(((params)+(i*4))>>2)] = result[i];
      }
    };
  var _emscripten_glGetActiveUniformsiv = _glGetActiveUniformsiv;

  /** @suppress {duplicate } */
  var _glGetAttachedShaders = (program, maxCount, count, shaders) => {
      var result = GLctx.getAttachedShaders(GL.programs[program]);
      var len = result.length;
      if (len > maxCount) {
        len = maxCount;
      }
      HEAP32[((count)>>2)] = len;
      for (var i = 0; i < len; ++i) {
        var id = GL.shaders.indexOf(result[i]);
        HEAP32[(((shaders)+(i*4))>>2)] = id;
      }
    };
  var _emscripten_glGetAttachedShaders = _glGetAttachedShaders;

  
  /** @suppress {duplicate } */
  var _glGetAttribLocation = (program, name) => {
      return GLctx.getAttribLocation(GL.programs[program], UTF8ToString(name));
    };
  var _emscripten_glGetAttribLocation = _glGetAttribLocation;

  var writeI53ToI64 = (ptr, num) => {
      HEAPU32[((ptr)>>2)] = num;
      var lower = HEAPU32[((ptr)>>2)];
      HEAPU32[(((ptr)+(4))>>2)] = (num - lower)/4294967296;
    };
  
  
  var webglGetExtensions = function $webglGetExtensions() {
      var exts = getEmscriptenSupportedExtensions(GLctx);
      exts = exts.concat(exts.map((e) => "GL_" + e));
      return exts;
    };
  
  var emscriptenWebGLGet = (name_, p, type) => {
      // Guard against user passing a null pointer.
      // Note that GLES2 spec does not say anything about how passing a null
      // pointer should be treated.  Testing on desktop core GL 3, the application
      // crashes on glGetIntegerv to a null pointer, but better to report an error
      // instead of doing anything random.
      if (!p) {
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      var ret = undefined;
      switch (name_) { // Handle a few trivial GLES values
        case 0x8DFA: // GL_SHADER_COMPILER
          ret = 1;
          break;
        case 0x8DF8: // GL_SHADER_BINARY_FORMATS
          if (type != 0 && type != 1) {
            GL.recordError(0x500); // GL_INVALID_ENUM
          }
          // Do not write anything to the out pointer, since no binary formats are
          // supported.
          return;
        case 0x87FE: // GL_NUM_PROGRAM_BINARY_FORMATS
        case 0x8DF9: // GL_NUM_SHADER_BINARY_FORMATS
          ret = 0;
          break;
        case 0x86A2: // GL_NUM_COMPRESSED_TEXTURE_FORMATS
          // WebGL doesn't have GL_NUM_COMPRESSED_TEXTURE_FORMATS (it's obsolete
          // since GL_COMPRESSED_TEXTURE_FORMATS returns a JS array that can be
          // queried for length), so implement it ourselves to allow C++ GLES2
          // code get the length.
          var formats = GLctx.getParameter(0x86A3 /*GL_COMPRESSED_TEXTURE_FORMATS*/);
          ret = formats ? formats.length : 0;
          break;
  
        case 0x821D: // GL_NUM_EXTENSIONS
          if (GL.currentContext.version < 2) {
            // Calling GLES3/WebGL2 function with a GLES2/WebGL1 context
            GL.recordError(0x502 /* GL_INVALID_OPERATION */);
            return;
          }
          ret = webglGetExtensions().length;
          break;
        case 0x821B: // GL_MAJOR_VERSION
        case 0x821C: // GL_MINOR_VERSION
          if (GL.currentContext.version < 2) {
            GL.recordError(0x500); // GL_INVALID_ENUM
            return;
          }
          ret = name_ == 0x821B ? 3 : 0; // return version 3.0
          break;
      }
  
      if (ret === undefined) {
        var result = GLctx.getParameter(name_);
        switch (typeof result) {
          case "number":
            ret = result;
            break;
          case "boolean":
            ret = result ? 1 : 0;
            break;
          case "string":
            GL.recordError(0x500); // GL_INVALID_ENUM
            return;
          case "object":
            if (result === null) {
              // null is a valid result for some (e.g., which buffer is bound -
              // perhaps nothing is bound), but otherwise can mean an invalid
              // name_, which we need to report as an error
              switch (name_) {
                case 0x8894: // ARRAY_BUFFER_BINDING
                case 0x8B8D: // CURRENT_PROGRAM
                case 0x8895: // ELEMENT_ARRAY_BUFFER_BINDING
                case 0x8CA6: // FRAMEBUFFER_BINDING or DRAW_FRAMEBUFFER_BINDING
                case 0x8CA7: // RENDERBUFFER_BINDING
                case 0x8069: // TEXTURE_BINDING_2D
                case 0x85B5: // WebGL 2 GL_VERTEX_ARRAY_BINDING, or WebGL 1 extension OES_vertex_array_object GL_VERTEX_ARRAY_BINDING_OES
                case 0x8F36: // COPY_READ_BUFFER_BINDING or COPY_READ_BUFFER
                case 0x8F37: // COPY_WRITE_BUFFER_BINDING or COPY_WRITE_BUFFER
                case 0x88ED: // PIXEL_PACK_BUFFER_BINDING
                case 0x88EF: // PIXEL_UNPACK_BUFFER_BINDING
                case 0x8CAA: // READ_FRAMEBUFFER_BINDING
                case 0x8919: // SAMPLER_BINDING
                case 0x8C1D: // TEXTURE_BINDING_2D_ARRAY
                case 0x806A: // TEXTURE_BINDING_3D
                case 0x8E25: // TRANSFORM_FEEDBACK_BINDING
                case 0x8C8F: // TRANSFORM_FEEDBACK_BUFFER_BINDING
                case 0x8A28: // UNIFORM_BUFFER_BINDING
                case 0x8514: { // TEXTURE_BINDING_CUBE_MAP
                  ret = 0;
                  break;
                }
                default: {
                  GL.recordError(0x500); // GL_INVALID_ENUM
                  return;
                }
              }
            } else if (result instanceof Float32Array ||
                       result instanceof Uint32Array ||
                       result instanceof Int32Array ||
                       result instanceof Array) {
              for (var i = 0; i < result.length; ++i) {
                switch (type) {
                  case 0: HEAP32[(((p)+(i*4))>>2)] = result[i]; break;
                  case 2: HEAPF32[(((p)+(i*4))>>2)] = result[i]; break;
                  case 4: HEAP8[(p)+(i)] = result[i] ? 1 : 0; break;
                }
              }
              return;
            } else {
              try {
                ret = result.name | 0;
              } catch(e) {
                GL.recordError(0x500); // GL_INVALID_ENUM
                err(`GL_INVALID_ENUM in glGet${type}v: Unknown object returned from WebGL getParameter(${name_})! (error: ${e})`);
                return;
              }
            }
            break;
          default:
            GL.recordError(0x500); // GL_INVALID_ENUM
            err(`GL_INVALID_ENUM in glGet${type}v: Native code calling glGet${type}v(${name_}) and it returns ${result} of type ${typeof(result)}!`);
            return;
        }
      }
  
      switch (type) {
        case 1: writeI53ToI64(p, ret); break;
        case 0: HEAP32[((p)>>2)] = ret; break;
        case 2:   HEAPF32[((p)>>2)] = ret; break;
        case 4: HEAP8[p] = ret ? 1 : 0; break;
      }
    };
  
  /** @suppress {duplicate } */
  var _glGetBooleanv = (name_, p) => emscriptenWebGLGet(name_, p, 4);
  var _emscripten_glGetBooleanv = _glGetBooleanv;

  /** @suppress {duplicate } */
  var _glGetBufferParameteri64v = (target, value, data) => {
      if (!data) {
        // GLES2 specification does not specify how to behave if data is a null pointer. Since calling this function does not make sense
        // if data == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      writeI53ToI64(data, GLctx.getBufferParameter(target, value));
    };
  var _emscripten_glGetBufferParameteri64v = _glGetBufferParameteri64v;

  /** @suppress {duplicate } */
  var _glGetBufferParameteriv = (target, value, data) => {
      if (!data) {
        // GLES2 specification does not specify how to behave if data is a null
        // pointer. Since calling this function does not make sense if data ==
        // null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      HEAP32[((data)>>2)] = GLctx.getBufferParameter(target, value);
    };
  var _emscripten_glGetBufferParameteriv = _glGetBufferParameteriv;

  /** @suppress {duplicate } */
  var _glGetError = () => {
      var error = GLctx.getError() || GL.lastError;
      GL.lastError = 0/*GL_NO_ERROR*/;
      return error;
    };
  var _emscripten_glGetError = _glGetError;

  
  /** @suppress {duplicate } */
  var _glGetFloatv = (name_, p) => emscriptenWebGLGet(name_, p, 2);
  var _emscripten_glGetFloatv = _glGetFloatv;

  /** @suppress {duplicate } */
  var _glGetFragDataLocation = (program, name) => {
      return GLctx.getFragDataLocation(GL.programs[program], UTF8ToString(name));
    };
  var _emscripten_glGetFragDataLocation = _glGetFragDataLocation;

  /** @suppress {duplicate } */
  var _glGetFramebufferAttachmentParameteriv = (target, attachment, pname, params) => {
      var result = GLctx.getFramebufferAttachmentParameter(target, attachment, pname);
      if (result instanceof WebGLRenderbuffer ||
          result instanceof WebGLTexture) {
        result = result.name | 0;
      }
      HEAP32[((params)>>2)] = result;
    };
  var _emscripten_glGetFramebufferAttachmentParameteriv = _glGetFramebufferAttachmentParameteriv;

  var emscriptenWebGLGetIndexed = (target, index, data, type) => {
      if (!data) {
        // GLES2 specification does not specify how to behave if data is a null pointer. Since calling this function does not make sense
        // if data == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      var result = GLctx.getIndexedParameter(target, index);
      var ret;
      switch (typeof result) {
        case 'boolean':
          ret = result ? 1 : 0;
          break;
        case 'number':
          ret = result;
          break;
        case 'object':
          if (result === null) {
            switch (target) {
              case 0x8C8F: // TRANSFORM_FEEDBACK_BUFFER_BINDING
              case 0x8A28: // UNIFORM_BUFFER_BINDING
                ret = 0;
                break;
              default: {
                GL.recordError(0x500); // GL_INVALID_ENUM
                return;
              }
            }
          } else if (result instanceof WebGLBuffer) {
            ret = result.name | 0;
          } else {
            GL.recordError(0x500); // GL_INVALID_ENUM
            return;
          }
          break;
        default:
          GL.recordError(0x500); // GL_INVALID_ENUM
          return;
      }
  
      switch (type) {
        case 1: writeI53ToI64(data, ret); break;
        case 0: HEAP32[((data)>>2)] = ret; break;
        case 2: HEAPF32[((data)>>2)] = ret; break;
        case 4: HEAP8[data] = ret ? 1 : 0; break;
        default: throw 'internal emscriptenWebGLGetIndexed() error, bad type: ' + type;
      }
    };
  /** @suppress {duplicate } */
  var _glGetInteger64i_v = (target, index, data) =>
      emscriptenWebGLGetIndexed(target, index, data, 1);
  var _emscripten_glGetInteger64i_v = _glGetInteger64i_v;

  /** @suppress {duplicate } */
  var _glGetInteger64v = (name_, p) => {
      emscriptenWebGLGet(name_, p, 1);
    };
  var _emscripten_glGetInteger64v = _glGetInteger64v;

  /** @suppress {duplicate } */
  var _glGetIntegeri_v = (target, index, data) =>
      emscriptenWebGLGetIndexed(target, index, data, 0);
  var _emscripten_glGetIntegeri_v = _glGetIntegeri_v;

  
  /** @suppress {duplicate } */
  var _glGetIntegerv = (name_, p) => emscriptenWebGLGet(name_, p, 0);
  var _emscripten_glGetIntegerv = _glGetIntegerv;

  /** @suppress {duplicate } */
  var _glGetInternalformativ = (target, internalformat, pname, bufSize, params) => {
      if (bufSize < 0) {
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      if (!params) {
        // GLES3 specification does not specify how to behave if values is a null pointer. Since calling this function does not make sense
        // if values == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      var ret = GLctx.getInternalformatParameter(target, internalformat, pname);
      if (ret === null) return;
      for (var i = 0; i < ret.length && i < bufSize; ++i) {
        HEAP32[(((params)+(i*4))>>2)] = ret[i];
      }
    };
  var _emscripten_glGetInternalformativ = _glGetInternalformativ;

  /** @suppress {duplicate } */
  var _glGetProgramBinary = (program, bufSize, length, binaryFormat, binary) => {
      GL.recordError(0x502/*GL_INVALID_OPERATION*/);
    };
  var _emscripten_glGetProgramBinary = _glGetProgramBinary;

  /** @suppress {duplicate } */
  var _glGetProgramInfoLog = (program, maxLength, length, infoLog) => {
      var log = GLctx.getProgramInfoLog(GL.programs[program]);
      if (log === null) log = '(unknown error)';
      var numBytesWrittenExclNull = (maxLength > 0 && infoLog) ? stringToUTF8(log, infoLog, maxLength) : 0;
      if (length) HEAP32[((length)>>2)] = numBytesWrittenExclNull;
    };
  var _emscripten_glGetProgramInfoLog = _glGetProgramInfoLog;

  /** @suppress {duplicate } */
  var _glGetProgramiv = (program, pname, p) => {
      if (!p) {
        // GLES2 specification does not specify how to behave if p is a null
        // pointer. Since calling this function does not make sense if p == null,
        // issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
  
      if (program >= GL.counter) {
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
  
      program = GL.programs[program];
  
      if (pname == 0x8B84) { // GL_INFO_LOG_LENGTH
        var log = GLctx.getProgramInfoLog(program);
        if (log === null) log = '(unknown error)';
        HEAP32[((p)>>2)] = log.length + 1;
      } else if (pname == 0x8B87 /* GL_ACTIVE_UNIFORM_MAX_LENGTH */) {
        if (!program.maxUniformLength) {
          for (var i = 0; i < GLctx.getProgramParameter(program, 0x8B86/*GL_ACTIVE_UNIFORMS*/); ++i) {
            program.maxUniformLength = Math.max(program.maxUniformLength, GLctx.getActiveUniform(program, i).name.length+1);
          }
        }
        HEAP32[((p)>>2)] = program.maxUniformLength;
      } else if (pname == 0x8B8A /* GL_ACTIVE_ATTRIBUTE_MAX_LENGTH */) {
        if (!program.maxAttributeLength) {
          for (var i = 0; i < GLctx.getProgramParameter(program, 0x8B89/*GL_ACTIVE_ATTRIBUTES*/); ++i) {
            program.maxAttributeLength = Math.max(program.maxAttributeLength, GLctx.getActiveAttrib(program, i).name.length+1);
          }
        }
        HEAP32[((p)>>2)] = program.maxAttributeLength;
      } else if (pname == 0x8A35 /* GL_ACTIVE_UNIFORM_BLOCK_MAX_NAME_LENGTH */) {
        if (!program.maxUniformBlockNameLength) {
          for (var i = 0; i < GLctx.getProgramParameter(program, 0x8A36/*GL_ACTIVE_UNIFORM_BLOCKS*/); ++i) {
            program.maxUniformBlockNameLength = Math.max(program.maxUniformBlockNameLength, GLctx.getActiveUniformBlockName(program, i).length+1);
          }
        }
        HEAP32[((p)>>2)] = program.maxUniformBlockNameLength;
      } else {
        HEAP32[((p)>>2)] = GLctx.getProgramParameter(program, pname);
      }
    };
  var _emscripten_glGetProgramiv = _glGetProgramiv;

  
  /** @suppress {duplicate } */
  var _glGetQueryObjecti64vEXT = (id, pname, params) => {
      if (!params) {
        // GLES2 specification does not specify how to behave if params is a null pointer. Since calling this function does not make sense
        // if p == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      var query = GL.queries[id];
      var param;
      if (GL.currentContext.version < 2)
      {
        param = GLctx.disjointTimerQueryExt['getQueryObjectEXT'](query, pname);
      }
      else {
        param = GLctx.getQueryParameter(query, pname);
      }
      var ret;
      if (typeof param == 'boolean') {
        ret = param ? 1 : 0;
      } else {
        ret = param;
      }
      writeI53ToI64(params, ret);
    };
  var _emscripten_glGetQueryObjecti64vEXT = _glGetQueryObjecti64vEXT;

  /** @suppress {duplicate } */
  var _glGetQueryObjectivEXT = (id, pname, params) => {
      if (!params) {
        // GLES2 specification does not specify how to behave if params is a null pointer. Since calling this function does not make sense
        // if p == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      var query = GL.queries[id];
      var param = GLctx.disjointTimerQueryExt['getQueryObjectEXT'](query, pname);
      var ret;
      if (typeof param == 'boolean') {
        ret = param ? 1 : 0;
      } else {
        ret = param;
      }
      HEAP32[((params)>>2)] = ret;
    };
  var _emscripten_glGetQueryObjectivEXT = _glGetQueryObjectivEXT;

  
  /** @suppress {duplicate } */
  var _glGetQueryObjectui64vEXT = _glGetQueryObjecti64vEXT;
  var _emscripten_glGetQueryObjectui64vEXT = _glGetQueryObjectui64vEXT;

  /** @suppress {duplicate } */
  var _glGetQueryObjectuiv = (id, pname, params) => {
      if (!params) {
        // GLES2 specification does not specify how to behave if params is a null pointer. Since calling this function does not make sense
        // if p == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      var query = GL.queries[id];
      var param = GLctx.getQueryParameter(query, pname);
      var ret;
      if (typeof param == 'boolean') {
        ret = param ? 1 : 0;
      } else {
        ret = param;
      }
      HEAP32[((params)>>2)] = ret;
    };
  var _emscripten_glGetQueryObjectuiv = _glGetQueryObjectuiv;

  
  /** @suppress {duplicate } */
  var _glGetQueryObjectuivEXT = _glGetQueryObjectivEXT;
  var _emscripten_glGetQueryObjectuivEXT = _glGetQueryObjectuivEXT;

  /** @suppress {duplicate } */
  var _glGetQueryiv = (target, pname, params) => {
      if (!params) {
        // GLES2 specification does not specify how to behave if params is a null pointer. Since calling this function does not make sense
        // if p == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      HEAP32[((params)>>2)] = GLctx.getQuery(target, pname);
    };
  var _emscripten_glGetQueryiv = _glGetQueryiv;

  /** @suppress {duplicate } */
  var _glGetQueryivEXT = (target, pname, params) => {
      if (!params) {
        // GLES2 specification does not specify how to behave if params is a null pointer. Since calling this function does not make sense
        // if p == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      HEAP32[((params)>>2)] = GLctx.disjointTimerQueryExt['getQueryEXT'](target, pname);
    };
  var _emscripten_glGetQueryivEXT = _glGetQueryivEXT;

  /** @suppress {duplicate } */
  var _glGetRenderbufferParameteriv = (target, pname, params) => {
      if (!params) {
        // GLES2 specification does not specify how to behave if params is a null pointer. Since calling this function does not make sense
        // if params == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      HEAP32[((params)>>2)] = GLctx.getRenderbufferParameter(target, pname);
    };
  var _emscripten_glGetRenderbufferParameteriv = _glGetRenderbufferParameteriv;

  /** @suppress {duplicate } */
  var _glGetSamplerParameterfv = (sampler, pname, params) => {
      if (!params) {
        // GLES3 specification does not specify how to behave if params is a null pointer. Since calling this function does not make sense
        // if p == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      HEAPF32[((params)>>2)] = GLctx.getSamplerParameter(GL.samplers[sampler], pname);
    };
  var _emscripten_glGetSamplerParameterfv = _glGetSamplerParameterfv;

  /** @suppress {duplicate } */
  var _glGetSamplerParameteriv = (sampler, pname, params) => {
      if (!params) {
        // GLES3 specification does not specify how to behave if params is a null pointer. Since calling this function does not make sense
        // if p == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      HEAP32[((params)>>2)] = GLctx.getSamplerParameter(GL.samplers[sampler], pname);
    };
  var _emscripten_glGetSamplerParameteriv = _glGetSamplerParameteriv;

  
  /** @suppress {duplicate } */
  var _glGetShaderInfoLog = (shader, maxLength, length, infoLog) => {
      var log = GLctx.getShaderInfoLog(GL.shaders[shader]);
      if (log === null) log = '(unknown error)';
      var numBytesWrittenExclNull = (maxLength > 0 && infoLog) ? stringToUTF8(log, infoLog, maxLength) : 0;
      if (length) HEAP32[((length)>>2)] = numBytesWrittenExclNull;
    };
  var _emscripten_glGetShaderInfoLog = _glGetShaderInfoLog;

  /** @suppress {duplicate } */
  var _glGetShaderPrecisionFormat = (shaderType, precisionType, range, precision) => {
      var result = GLctx.getShaderPrecisionFormat(shaderType, precisionType);
      HEAP32[((range)>>2)] = result.rangeMin;
      HEAP32[(((range)+(4))>>2)] = result.rangeMax;
      HEAP32[((precision)>>2)] = result.precision;
    };
  var _emscripten_glGetShaderPrecisionFormat = _glGetShaderPrecisionFormat;

  /** @suppress {duplicate } */
  var _glGetShaderSource = (shader, bufSize, length, source) => {
      var result = GLctx.getShaderSource(GL.shaders[shader]);
      if (!result) return; // If an error occurs, nothing will be written to length or source.
      var numBytesWrittenExclNull = (bufSize > 0 && source) ? stringToUTF8(result, source, bufSize) : 0;
      if (length) HEAP32[((length)>>2)] = numBytesWrittenExclNull;
    };
  var _emscripten_glGetShaderSource = _glGetShaderSource;

  /** @suppress {duplicate } */
  var _glGetShaderiv = (shader, pname, p) => {
      if (!p) {
        // GLES2 specification does not specify how to behave if p is a null
        // pointer. Since calling this function does not make sense if p == null,
        // issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      if (pname == 0x8B84) { // GL_INFO_LOG_LENGTH
        var log = GLctx.getShaderInfoLog(GL.shaders[shader]);
        if (log === null) log = '(unknown error)';
        // The GLES2 specification says that if the shader has an empty info log,
        // a value of 0 is returned. Otherwise the log has a null char appended.
        // (An empty string is falsey, so we can just check that instead of
        // looking at log.length.)
        var logLength = log ? log.length + 1 : 0;
        HEAP32[((p)>>2)] = logLength;
      } else if (pname == 0x8B88) { // GL_SHADER_SOURCE_LENGTH
        var source = GLctx.getShaderSource(GL.shaders[shader]);
        // source may be a null, or the empty string, both of which are falsey
        // values that we report a 0 length for.
        var sourceLength = source ? source.length + 1 : 0;
        HEAP32[((p)>>2)] = sourceLength;
      } else {
        HEAP32[((p)>>2)] = GLctx.getShaderParameter(GL.shaders[shader], pname);
      }
    };
  var _emscripten_glGetShaderiv = _glGetShaderiv;

  
  
  /** @suppress {duplicate } */
  var _glGetString = (name_) => {
      var ret = GL.stringCache[name_];
      if (!ret) {
        switch (name_) {
          case 0x1F03 /* GL_EXTENSIONS */:
            ret = stringToNewUTF8(webglGetExtensions().join(' '));
            break;
          case 0x1F00 /* GL_VENDOR */:
          case 0x1F01 /* GL_RENDERER */:
          case 0x9245 /* UNMASKED_VENDOR_WEBGL */:
          case 0x9246 /* UNMASKED_RENDERER_WEBGL */:
            var s = GLctx.getParameter(name_);
            if (!s) {
              GL.recordError(0x500/*GL_INVALID_ENUM*/);
            }
            ret = s ? stringToNewUTF8(s) : 0;
            break;
  
          case 0x1F02 /* GL_VERSION */:
            var glVersion = GLctx.getParameter(0x1F02 /*GL_VERSION*/);
            // return GLES version string corresponding to the version of the WebGL context
            if (true) glVersion = `OpenGL ES 3.0 (${glVersion})`;
            else
            {
              glVersion = `OpenGL ES 2.0 (${glVersion})`;
            }
            ret = stringToNewUTF8(glVersion);
            break;
          case 0x8B8C /* GL_SHADING_LANGUAGE_VERSION */:
            var glslVersion = GLctx.getParameter(0x8B8C /*GL_SHADING_LANGUAGE_VERSION*/);
            // extract the version number 'N.M' from the string 'WebGL GLSL ES N.M ...'
            var ver_re = /^WebGL GLSL ES ([0-9]\.[0-9][0-9]?)(?:$| .*)/;
            var ver_num = glslVersion.match(ver_re);
            if (ver_num !== null) {
              if (ver_num[1].length == 3) ver_num[1] = ver_num[1] + '0'; // ensure minor version has 2 digits
              glslVersion = `OpenGL ES GLSL ES ${ver_num[1]} (${glslVersion})`;
            }
            ret = stringToNewUTF8(glslVersion);
            break;
          default:
            GL.recordError(0x500/*GL_INVALID_ENUM*/);
            // fall through
        }
        GL.stringCache[name_] = ret;
      }
      return ret;
    };
  var _emscripten_glGetString = _glGetString;

  
  /** @suppress {duplicate } */
  var _glGetStringi = (name, index) => {
      if (GL.currentContext.version < 2) {
        GL.recordError(0x502 /* GL_INVALID_OPERATION */); // Calling GLES3/WebGL2 function with a GLES2/WebGL1 context
        return 0;
      }
      var stringiCache = GL.stringiCache[name];
      if (stringiCache) {
        if (index < 0 || index >= stringiCache.length) {
          GL.recordError(0x501/*GL_INVALID_VALUE*/);
          return 0;
        }
        return stringiCache[index];
      }
      switch (name) {
        case 0x1F03 /* GL_EXTENSIONS */:
          var exts = webglGetExtensions().map(stringToNewUTF8);
          stringiCache = GL.stringiCache[name] = exts;
          if (index < 0 || index >= stringiCache.length) {
            GL.recordError(0x501/*GL_INVALID_VALUE*/);
            return 0;
          }
          return stringiCache[index];
        default:
          GL.recordError(0x500/*GL_INVALID_ENUM*/);
          return 0;
      }
    };
  var _emscripten_glGetStringi = _glGetStringi;

  /** @suppress {duplicate } */
  var _glGetSynciv = (sync, pname, bufSize, length, values) => {
      if (bufSize < 0) {
        // GLES3 specification does not specify how to behave if bufSize < 0, however in the spec wording for glGetInternalformativ, it does say that GL_INVALID_VALUE should be raised,
        // so raise GL_INVALID_VALUE here as well.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      if (!values) {
        // GLES3 specification does not specify how to behave if values is a null pointer. Since calling this function does not make sense
        // if values == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      var ret = GLctx.getSyncParameter(GL.syncs[sync], pname);
      if (ret !== null) {
        HEAP32[((values)>>2)] = ret;
        if (length) HEAP32[((length)>>2)] = 1; // Report a single value outputted.
      }
    };
  var _emscripten_glGetSynciv = _glGetSynciv;

  /** @suppress {duplicate } */
  var _glGetTexParameterfv = (target, pname, params) => {
      if (!params) {
        // GLES2 specification does not specify how to behave if params is a null
        // pointer. Since calling this function does not make sense if p == null,
        // issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      HEAPF32[((params)>>2)] = GLctx.getTexParameter(target, pname);
    };
  var _emscripten_glGetTexParameterfv = _glGetTexParameterfv;

  /** @suppress {duplicate } */
  var _glGetTexParameteriv = (target, pname, params) => {
      if (!params) {
        // GLES2 specification does not specify how to behave if params is a null
        // pointer. Since calling this function does not make sense if p == null,
        // issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      HEAP32[((params)>>2)] = GLctx.getTexParameter(target, pname);
    };
  var _emscripten_glGetTexParameteriv = _glGetTexParameteriv;

  /** @suppress {duplicate } */
  var _glGetTransformFeedbackVarying = (program, index, bufSize, length, size, type, name) => {
      program = GL.programs[program];
      var info = GLctx.getTransformFeedbackVarying(program, index);
      if (!info) return; // If an error occurred, the return parameters length, size, type and name will be unmodified.
  
      if (name && bufSize > 0) {
        var numBytesWrittenExclNull = stringToUTF8(info.name, name, bufSize);
        if (length) HEAP32[((length)>>2)] = numBytesWrittenExclNull;
      } else {
        if (length) HEAP32[((length)>>2)] = 0;
      }
  
      if (size) HEAP32[((size)>>2)] = info.size;
      if (type) HEAP32[((type)>>2)] = info.type;
    };
  var _emscripten_glGetTransformFeedbackVarying = _glGetTransformFeedbackVarying;

  /** @suppress {duplicate } */
  var _glGetUniformBlockIndex = (program, uniformBlockName) => {
      return GLctx.getUniformBlockIndex(GL.programs[program], UTF8ToString(uniformBlockName));
    };
  var _emscripten_glGetUniformBlockIndex = _glGetUniformBlockIndex;

  /** @suppress {duplicate } */
  var _glGetUniformIndices = (program, uniformCount, uniformNames, uniformIndices) => {
      if (!uniformIndices) {
        // GLES2 specification does not specify how to behave if uniformIndices is a null pointer. Since calling this function does not make sense
        // if uniformIndices == null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      if (uniformCount > 0 && (uniformNames == 0 || uniformIndices == 0)) {
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      program = GL.programs[program];
      var names = [];
      for (var i = 0; i < uniformCount; i++)
        names.push(UTF8ToString(HEAP32[(((uniformNames)+(i*4))>>2)]));
  
      var result = GLctx.getUniformIndices(program, names);
      if (!result) return; // GL spec: If an error is generated, nothing is written out to uniformIndices.
  
      var len = result.length;
      for (var i = 0; i < len; i++) {
        HEAP32[(((uniformIndices)+(i*4))>>2)] = result[i];
      }
    };
  var _emscripten_glGetUniformIndices = _glGetUniformIndices;

  
  /** @noinline */
  var webglGetLeftBracePos = (name) => name.slice(-1) == ']' && name.lastIndexOf('[');
  
  var webglPrepareUniformLocationsBeforeFirstUse = (program) => {
      var uniformLocsById = program.uniformLocsById, // Maps GLuint -> WebGLUniformLocation
        uniformSizeAndIdsByName = program.uniformSizeAndIdsByName, // Maps name -> [uniform array length, GLuint]
        i, j;
  
      // On the first time invocation of glGetUniformLocation on this shader program:
      // initialize cache data structures and discover which uniforms are arrays.
      if (!uniformLocsById) {
        // maps GLint integer locations to WebGLUniformLocations
        program.uniformLocsById = uniformLocsById = {};
        // maps integer locations back to uniform name strings, so that we can lazily fetch uniform array locations
        program.uniformArrayNamesById = {};
  
        for (i = 0; i < GLctx.getProgramParameter(program, 0x8B86/*GL_ACTIVE_UNIFORMS*/); ++i) {
          var u = GLctx.getActiveUniform(program, i);
          var nm = u.name;
          var sz = u.size;
          var lb = webglGetLeftBracePos(nm);
          var arrayName = lb > 0 ? nm.slice(0, lb) : nm;
  
          // Assign a new location.
          var id = program.uniformIdCounter;
          program.uniformIdCounter += sz;
          // Eagerly get the location of the uniformArray[0] base element.
          // The remaining indices >0 will be left for lazy evaluation to
          // improve performance. Those may never be needed to fetch, if the
          // application fills arrays always in full starting from the first
          // element of the array.
          uniformSizeAndIdsByName[arrayName] = [sz, id];
  
          // Store placeholder integers in place that highlight that these
          // >0 index locations are array indices pending population.
          for (j = 0; j < sz; ++j) {
            uniformLocsById[id] = j;
            program.uniformArrayNamesById[id++] = arrayName;
          }
        }
      }
    };
  
  
  
  /** @suppress {duplicate } */
  var _glGetUniformLocation = (program, name) => {
  
      name = UTF8ToString(name);
  
      if (program = GL.programs[program]) {
        webglPrepareUniformLocationsBeforeFirstUse(program);
        var uniformLocsById = program.uniformLocsById; // Maps GLuint -> WebGLUniformLocation
        var arrayIndex = 0;
        var uniformBaseName = name;
  
        // Invariant: when populating integer IDs for uniform locations, we must
        // maintain the precondition that arrays reside in contiguous addresses,
        // i.e. for a 'vec4 colors[10];', colors[4] must be at location
        // colors[0]+4.  However, user might call glGetUniformLocation(program,
        // "colors") for an array, so we cannot discover based on the user input
        // arguments whether the uniform we are dealing with is an array. The only
        // way to discover which uniforms are arrays is to enumerate over all the
        // active uniforms in the program.
        var leftBrace = webglGetLeftBracePos(name);
  
        // If user passed an array accessor "[index]", parse the array index off the accessor.
        if (leftBrace > 0) {
          arrayIndex = jstoi_q(name.slice(leftBrace + 1)) >>> 0; // "index]", coerce parseInt(']') with >>>0 to treat "foo[]" as "foo[0]" and foo[-1] as unsigned out-of-bounds.
          uniformBaseName = name.slice(0, leftBrace);
        }
  
        // Have we cached the location of this uniform before?
        // A pair [array length, GLint of the uniform location]
        var sizeAndId = program.uniformSizeAndIdsByName[uniformBaseName];
  
        // If an uniform with this name exists, and if its index is within the
        // array limits (if it's even an array), query the WebGLlocation, or
        // return an existing cached location.
        if (sizeAndId && arrayIndex < sizeAndId[0]) {
          arrayIndex += sizeAndId[1]; // Add the base location of the uniform to the array index offset.
          if ((uniformLocsById[arrayIndex] = uniformLocsById[arrayIndex] || GLctx.getUniformLocation(program, name))) {
            return arrayIndex;
          }
        }
      }
      else {
        // N.b. we are currently unable to distinguish between GL program IDs that
        // never existed vs GL program IDs that have been deleted, so report
        // GL_INVALID_VALUE in both cases.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
      }
      return -1;
    };
  var _emscripten_glGetUniformLocation = _glGetUniformLocation;

  var webglGetUniformLocation = (location) => {
      var p = GLctx.currentProgram;
  
      if (p) {
        var webglLoc = p.uniformLocsById[location];
        // p.uniformLocsById[location] stores either an integer, or a
        // WebGLUniformLocation.
        // If an integer, we have not yet bound the location, so do it now. The
        // integer value specifies the array index we should bind to.
        if (typeof webglLoc == 'number') {
          p.uniformLocsById[location] = webglLoc = GLctx.getUniformLocation(p, p.uniformArrayNamesById[location] + (webglLoc > 0 ? `[${webglLoc}]` : ''));
        }
        // Else an already cached WebGLUniformLocation, return it.
        return webglLoc;
      } else {
        GL.recordError(0x502/*GL_INVALID_OPERATION*/);
      }
    };
  
  
  /** @suppress{checkTypes} */
  var emscriptenWebGLGetUniform = (program, location, params, type) => {
      if (!params) {
        // GLES2 specification does not specify how to behave if params is a null
        // pointer. Since calling this function does not make sense if params ==
        // null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      program = GL.programs[program];
      webglPrepareUniformLocationsBeforeFirstUse(program);
      var data = GLctx.getUniform(program, webglGetUniformLocation(location));
      if (typeof data == 'number' || typeof data == 'boolean') {
        switch (type) {
          case 0: HEAP32[((params)>>2)] = data; break;
          case 2: HEAPF32[((params)>>2)] = data; break;
        }
      } else {
        for (var i = 0; i < data.length; i++) {
          switch (type) {
            case 0: HEAP32[(((params)+(i*4))>>2)] = data[i]; break;
            case 2: HEAPF32[(((params)+(i*4))>>2)] = data[i]; break;
          }
        }
      }
    };
  
  /** @suppress {duplicate } */
  var _glGetUniformfv = (program, location, params) => {
      emscriptenWebGLGetUniform(program, location, params, 2);
    };
  var _emscripten_glGetUniformfv = _glGetUniformfv;

  
  /** @suppress {duplicate } */
  var _glGetUniformiv = (program, location, params) => {
      emscriptenWebGLGetUniform(program, location, params, 0);
    };
  var _emscripten_glGetUniformiv = _glGetUniformiv;

  /** @suppress {duplicate } */
  var _glGetUniformuiv = (program, location, params) =>
      emscriptenWebGLGetUniform(program, location, params, 0);
  var _emscripten_glGetUniformuiv = _glGetUniformuiv;

  /** @suppress{checkTypes} */
  var emscriptenWebGLGetVertexAttrib = (index, pname, params, type) => {
      if (!params) {
        // GLES2 specification does not specify how to behave if params is a null
        // pointer. Since calling this function does not make sense if params ==
        // null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      var data = GLctx.getVertexAttrib(index, pname);
      if (pname == 0x889F/*VERTEX_ATTRIB_ARRAY_BUFFER_BINDING*/) {
        HEAP32[((params)>>2)] = data && data["name"];
      } else if (typeof data == 'number' || typeof data == 'boolean') {
        switch (type) {
          case 0: HEAP32[((params)>>2)] = data; break;
          case 2: HEAPF32[((params)>>2)] = data; break;
          case 5: HEAP32[((params)>>2)] = Math.fround(data); break;
        }
      } else {
        for (var i = 0; i < data.length; i++) {
          switch (type) {
            case 0: HEAP32[(((params)+(i*4))>>2)] = data[i]; break;
            case 2: HEAPF32[(((params)+(i*4))>>2)] = data[i]; break;
            case 5: HEAP32[(((params)+(i*4))>>2)] = Math.fround(data[i]); break;
          }
        }
      }
    };
  /** @suppress {duplicate } */
  var _glGetVertexAttribIiv = (index, pname, params) => {
      // N.B. This function may only be called if the vertex attribute was specified using the function glVertexAttribI4iv(),
      // otherwise the results are undefined. (GLES3 spec 6.1.12)
      emscriptenWebGLGetVertexAttrib(index, pname, params, 0);
    };
  var _emscripten_glGetVertexAttribIiv = _glGetVertexAttribIiv;

  
  /** @suppress {duplicate } */
  var _glGetVertexAttribIuiv = _glGetVertexAttribIiv;
  var _emscripten_glGetVertexAttribIuiv = _glGetVertexAttribIuiv;

  /** @suppress {duplicate } */
  var _glGetVertexAttribPointerv = (index, pname, pointer) => {
      if (!pointer) {
        // GLES2 specification does not specify how to behave if pointer is a null
        // pointer. Since calling this function does not make sense if pointer ==
        // null, issue a GL error to notify user about it.
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
      }
      HEAP32[((pointer)>>2)] = GLctx.getVertexAttribOffset(index, pname);
    };
  var _emscripten_glGetVertexAttribPointerv = _glGetVertexAttribPointerv;

  
  /** @suppress {duplicate } */
  var _glGetVertexAttribfv = (index, pname, params) => {
      // N.B. This function may only be called if the vertex attribute was
      // specified using the function glVertexAttrib*f(), otherwise the results
      // are undefined. (GLES3 spec 6.1.12)
      emscriptenWebGLGetVertexAttrib(index, pname, params, 2);
    };
  var _emscripten_glGetVertexAttribfv = _glGetVertexAttribfv;

  
  /** @suppress {duplicate } */
  var _glGetVertexAttribiv = (index, pname, params) => {
      // N.B. This function may only be called if the vertex attribute was
      // specified using the function glVertexAttrib*f(), otherwise the results
      // are undefined. (GLES3 spec 6.1.12)
      emscriptenWebGLGetVertexAttrib(index, pname, params, 5);
    };
  var _emscripten_glGetVertexAttribiv = _glGetVertexAttribiv;

  /** @suppress {duplicate } */
  var _glHint = (x0, x1) => GLctx.hint(x0, x1);
  var _emscripten_glHint = _glHint;

  /** @suppress {duplicate } */
  var _glInvalidateFramebuffer = (target, numAttachments, attachments) => {
      var list = tempFixedLengthArray[numAttachments];
      for (var i = 0; i < numAttachments; i++) {
        list[i] = HEAP32[(((attachments)+(i*4))>>2)];
      }
  
      GLctx.invalidateFramebuffer(target, list);
    };
  var _emscripten_glInvalidateFramebuffer = _glInvalidateFramebuffer;

  /** @suppress {duplicate } */
  var _glInvalidateSubFramebuffer = (target, numAttachments, attachments, x, y, width, height) => {
      var list = tempFixedLengthArray[numAttachments];
      for (var i = 0; i < numAttachments; i++) {
        list[i] = HEAP32[(((attachments)+(i*4))>>2)];
      }
  
      GLctx.invalidateSubFramebuffer(target, list, x, y, width, height);
    };
  var _emscripten_glInvalidateSubFramebuffer = _glInvalidateSubFramebuffer;

  /** @suppress {duplicate } */
  var _glIsBuffer = (buffer) => {
      var b = GL.buffers[buffer];
      if (!b) return 0;
      return GLctx.isBuffer(b);
    };
  var _emscripten_glIsBuffer = _glIsBuffer;

  /** @suppress {duplicate } */
  var _glIsEnabled = (x0) => GLctx.isEnabled(x0);
  var _emscripten_glIsEnabled = _glIsEnabled;

  /** @suppress {duplicate } */
  var _glIsFramebuffer = (framebuffer) => {
      var fb = GL.framebuffers[framebuffer];
      if (!fb) return 0;
      return GLctx.isFramebuffer(fb);
    };
  var _emscripten_glIsFramebuffer = _glIsFramebuffer;

  /** @suppress {duplicate } */
  var _glIsProgram = (program) => {
      program = GL.programs[program];
      if (!program) return 0;
      return GLctx.isProgram(program);
    };
  var _emscripten_glIsProgram = _glIsProgram;

  /** @suppress {duplicate } */
  var _glIsQuery = (id) => {
      var query = GL.queries[id];
      if (!query) return 0;
      return GLctx.isQuery(query);
    };
  var _emscripten_glIsQuery = _glIsQuery;

  /** @suppress {duplicate } */
  var _glIsQueryEXT = (id) => {
      var query = GL.queries[id];
      if (!query) return 0;
      return GLctx.disjointTimerQueryExt['isQueryEXT'](query);
    };
  var _emscripten_glIsQueryEXT = _glIsQueryEXT;

  /** @suppress {duplicate } */
  var _glIsRenderbuffer = (renderbuffer) => {
      var rb = GL.renderbuffers[renderbuffer];
      if (!rb) return 0;
      return GLctx.isRenderbuffer(rb);
    };
  var _emscripten_glIsRenderbuffer = _glIsRenderbuffer;

  /** @suppress {duplicate } */
  var _glIsSampler = (id) => {
      var sampler = GL.samplers[id];
      if (!sampler) return 0;
      return GLctx.isSampler(sampler);
    };
  var _emscripten_glIsSampler = _glIsSampler;

  /** @suppress {duplicate } */
  var _glIsShader = (shader) => {
      var s = GL.shaders[shader];
      if (!s) return 0;
      return GLctx.isShader(s);
    };
  var _emscripten_glIsShader = _glIsShader;

  /** @suppress {duplicate } */
  var _glIsSync = (sync) => GLctx.isSync(GL.syncs[sync]);
  var _emscripten_glIsSync = _glIsSync;

  /** @suppress {duplicate } */
  var _glIsTexture = (id) => {
      var texture = GL.textures[id];
      if (!texture) return 0;
      return GLctx.isTexture(texture);
    };
  var _emscripten_glIsTexture = _glIsTexture;

  /** @suppress {duplicate } */
  var _glIsTransformFeedback = (id) => GLctx.isTransformFeedback(GL.transformFeedbacks[id]);
  var _emscripten_glIsTransformFeedback = _glIsTransformFeedback;

  /** @suppress {duplicate } */
  var _glIsVertexArray = (array) => {
  
      var vao = GL.vaos[array];
      if (!vao) return 0;
      return GLctx.isVertexArray(vao);
    };
  var _emscripten_glIsVertexArray = _glIsVertexArray;

  
  /** @suppress {duplicate } */
  var _glIsVertexArrayOES = _glIsVertexArray;
  var _emscripten_glIsVertexArrayOES = _glIsVertexArrayOES;

  /** @suppress {duplicate } */
  var _glLineWidth = (x0) => GLctx.lineWidth(x0);
  var _emscripten_glLineWidth = _glLineWidth;

  /** @suppress {duplicate } */
  var _glLinkProgram = (program) => {
      program = GL.programs[program];
      GLctx.linkProgram(program);
      // Invalidate earlier computed uniform->ID mappings, those have now become stale
      program.uniformLocsById = 0; // Mark as null-like so that glGetUniformLocation() knows to populate this again.
      program.uniformSizeAndIdsByName = {};
  
    };
  var _emscripten_glLinkProgram = _glLinkProgram;

  /** @suppress {duplicate } */
  var _glPauseTransformFeedback = () => GLctx.pauseTransformFeedback();
  var _emscripten_glPauseTransformFeedback = _glPauseTransformFeedback;

  /** @suppress {duplicate } */
  var _glPixelStorei = (pname, param) => {
      if (pname == 0xCF5 /* GL_UNPACK_ALIGNMENT */) {
        GL.unpackAlignment = param;
      }
      GLctx.pixelStorei(pname, param);
    };
  var _emscripten_glPixelStorei = _glPixelStorei;

  /** @suppress {duplicate } */
  var _glPolygonOffset = (x0, x1) => GLctx.polygonOffset(x0, x1);
  var _emscripten_glPolygonOffset = _glPolygonOffset;

  /** @suppress {duplicate } */
  var _glProgramBinary = (program, binaryFormat, binary, length) => {
      GL.recordError(0x500/*GL_INVALID_ENUM*/);
    };
  var _emscripten_glProgramBinary = _glProgramBinary;

  /** @suppress {duplicate } */
  var _glProgramParameteri = (program, pname, value) => {
      GL.recordError(0x500/*GL_INVALID_ENUM*/);
    };
  var _emscripten_glProgramParameteri = _glProgramParameteri;

  /** @suppress {duplicate } */
  var _glQueryCounterEXT = (id, target) => {
      GLctx.disjointTimerQueryExt['queryCounterEXT'](GL.queries[id], target);
    };
  var _emscripten_glQueryCounterEXT = _glQueryCounterEXT;

  /** @suppress {duplicate } */
  var _glReadBuffer = (x0) => GLctx.readBuffer(x0);
  var _emscripten_glReadBuffer = _glReadBuffer;

  var computeUnpackAlignedImageSize = (width, height, sizePerPixel, alignment) => {
      function roundedToNextMultipleOf(x, y) {
        return (x + y - 1) & -y;
      }
      var plainRowSize = width * sizePerPixel;
      var alignedRowSize = roundedToNextMultipleOf(plainRowSize, alignment);
      return height * alignedRowSize;
    };
  
  var colorChannelsInGlTextureFormat = (format) => {
      // Micro-optimizations for size: map format to size by subtracting smallest
      // enum value (0x1902) from all values first.  Also omit the most common
      // size value (1) from the list, which is assumed by formats not on the
      // list.
      var colorChannels = {
        // 0x1902 /* GL_DEPTH_COMPONENT */ - 0x1902: 1,
        // 0x1906 /* GL_ALPHA */ - 0x1902: 1,
        5: 3,
        6: 4,
        // 0x1909 /* GL_LUMINANCE */ - 0x1902: 1,
        8: 2,
        29502: 3,
        29504: 4,
        // 0x1903 /* GL_RED */ - 0x1902: 1,
        26917: 2,
        26918: 2,
        // 0x8D94 /* GL_RED_INTEGER */ - 0x1902: 1,
        29846: 3,
        29847: 4
      };
      return colorChannels[format - 0x1902]||1;
    };
  
  var heapObjectForWebGLType = (type) => {
      // Micro-optimization for size: Subtract lowest GL enum number (0x1400/* GL_BYTE */) from type to compare
      // smaller values for the heap, for shorter generated code size.
      // Also the type HEAPU16 is not tested for explicitly, but any unrecognized type will return out HEAPU16.
      // (since most types are HEAPU16)
      type -= 0x1400;
      if (type == 0) return HEAP8;
  
      if (type == 1) return HEAPU8;
  
      if (type == 2) return HEAP16;
  
      if (type == 4) return HEAP32;
  
      if (type == 6) return HEAPF32;
  
      if (type == 5
        || type == 28922
        || type == 28520
        || type == 30779
        || type == 30782
        )
        return HEAPU32;
  
      return HEAPU16;
    };
  
  var toTypedArrayIndex = (pointer, heap) =>
      pointer >>> (31 - Math.clz32(heap.BYTES_PER_ELEMENT));
  
  var emscriptenWebGLGetTexPixelData = (type, format, width, height, pixels, internalFormat) => {
      var heap = heapObjectForWebGLType(type);
      var sizePerPixel = colorChannelsInGlTextureFormat(format) * heap.BYTES_PER_ELEMENT;
      var bytes = computeUnpackAlignedImageSize(width, height, sizePerPixel, GL.unpackAlignment);
      return heap.subarray(toTypedArrayIndex(pixels, heap), toTypedArrayIndex(pixels + bytes, heap));
    };
  
  
  
  /** @suppress {duplicate } */
  var _glReadPixels = (x, y, width, height, format, type, pixels) => {
      if (true) {
        if (GLctx.currentPixelPackBufferBinding) {
          GLctx.readPixels(x, y, width, height, format, type, pixels);
          return;
        }
        var heap = heapObjectForWebGLType(type);
        var target = toTypedArrayIndex(pixels, heap);
        GLctx.readPixels(x, y, width, height, format, type, heap, target);
        return;
      }
      var pixelData = emscriptenWebGLGetTexPixelData(type, format, width, height, pixels, format);
      if (!pixelData) {
        GL.recordError(0x500/*GL_INVALID_ENUM*/);
        return;
      }
      GLctx.readPixels(x, y, width, height, format, type, pixelData);
    };
  var _emscripten_glReadPixels = _glReadPixels;

  /** @suppress {duplicate } */
  var _glReleaseShaderCompiler = () => {
      // NOP (as allowed by GLES 2.0 spec)
    };
  var _emscripten_glReleaseShaderCompiler = _glReleaseShaderCompiler;

  /** @suppress {duplicate } */
  var _glRenderbufferStorage = (x0, x1, x2, x3) => GLctx.renderbufferStorage(x0, x1, x2, x3);
  var _emscripten_glRenderbufferStorage = _glRenderbufferStorage;

  /** @suppress {duplicate } */
  var _glRenderbufferStorageMultisample = (x0, x1, x2, x3, x4) => GLctx.renderbufferStorageMultisample(x0, x1, x2, x3, x4);
  var _emscripten_glRenderbufferStorageMultisample = _glRenderbufferStorageMultisample;

  /** @suppress {duplicate } */
  var _glResumeTransformFeedback = () => GLctx.resumeTransformFeedback();
  var _emscripten_glResumeTransformFeedback = _glResumeTransformFeedback;

  /** @suppress {duplicate } */
  var _glSampleCoverage = (value, invert) => {
      GLctx.sampleCoverage(value, !!invert);
    };
  var _emscripten_glSampleCoverage = _glSampleCoverage;

  /** @suppress {duplicate } */
  var _glSamplerParameterf = (sampler, pname, param) => {
      GLctx.samplerParameterf(GL.samplers[sampler], pname, param);
    };
  var _emscripten_glSamplerParameterf = _glSamplerParameterf;

  /** @suppress {duplicate } */
  var _glSamplerParameterfv = (sampler, pname, params) => {
      var param = HEAPF32[((params)>>2)];
      GLctx.samplerParameterf(GL.samplers[sampler], pname, param);
    };
  var _emscripten_glSamplerParameterfv = _glSamplerParameterfv;

  /** @suppress {duplicate } */
  var _glSamplerParameteri = (sampler, pname, param) => {
      GLctx.samplerParameteri(GL.samplers[sampler], pname, param);
    };
  var _emscripten_glSamplerParameteri = _glSamplerParameteri;

  /** @suppress {duplicate } */
  var _glSamplerParameteriv = (sampler, pname, params) => {
      var param = HEAP32[((params)>>2)];
      GLctx.samplerParameteri(GL.samplers[sampler], pname, param);
    };
  var _emscripten_glSamplerParameteriv = _glSamplerParameteriv;

  /** @suppress {duplicate } */
  var _glScissor = (x0, x1, x2, x3) => GLctx.scissor(x0, x1, x2, x3);
  var _emscripten_glScissor = _glScissor;

  /** @suppress {duplicate } */
  var _glShaderBinary = (count, shaders, binaryformat, binary, length) => {
      GL.recordError(0x500/*GL_INVALID_ENUM*/);
    };
  var _emscripten_glShaderBinary = _glShaderBinary;

  /** @suppress {duplicate } */
  var _glShaderSource = (shader, count, string, length) => {
      var source = GL.getSource(shader, count, string, length);
  
      GLctx.shaderSource(GL.shaders[shader], source);
    };
  var _emscripten_glShaderSource = _glShaderSource;

  /** @suppress {duplicate } */
  var _glStencilFunc = (x0, x1, x2) => GLctx.stencilFunc(x0, x1, x2);
  var _emscripten_glStencilFunc = _glStencilFunc;

  /** @suppress {duplicate } */
  var _glStencilFuncSeparate = (x0, x1, x2, x3) => GLctx.stencilFuncSeparate(x0, x1, x2, x3);
  var _emscripten_glStencilFuncSeparate = _glStencilFuncSeparate;

  /** @suppress {duplicate } */
  var _glStencilMask = (x0) => GLctx.stencilMask(x0);
  var _emscripten_glStencilMask = _glStencilMask;

  /** @suppress {duplicate } */
  var _glStencilMaskSeparate = (x0, x1) => GLctx.stencilMaskSeparate(x0, x1);
  var _emscripten_glStencilMaskSeparate = _glStencilMaskSeparate;

  /** @suppress {duplicate } */
  var _glStencilOp = (x0, x1, x2) => GLctx.stencilOp(x0, x1, x2);
  var _emscripten_glStencilOp = _glStencilOp;

  /** @suppress {duplicate } */
  var _glStencilOpSeparate = (x0, x1, x2, x3) => GLctx.stencilOpSeparate(x0, x1, x2, x3);
  var _emscripten_glStencilOpSeparate = _glStencilOpSeparate;

  
  
  
  /** @suppress {duplicate } */
  var _glTexImage2D = (target, level, internalFormat, width, height, border, format, type, pixels) => {
      if (true) {
        if (GLctx.currentPixelUnpackBufferBinding) {
          GLctx.texImage2D(target, level, internalFormat, width, height, border, format, type, pixels);
          return;
        }
        if (pixels) {
          var heap = heapObjectForWebGLType(type);
          var index = toTypedArrayIndex(pixels, heap);
          GLctx.texImage2D(target, level, internalFormat, width, height, border, format, type, heap, index);
          return;
        }
      }
      var pixelData = pixels ? emscriptenWebGLGetTexPixelData(type, format, width, height, pixels, internalFormat) : null;
      GLctx.texImage2D(target, level, internalFormat, width, height, border, format, type, pixelData);
    };
  var _emscripten_glTexImage2D = _glTexImage2D;

  
  /** @suppress {duplicate } */
  var _glTexImage3D = (target, level, internalFormat, width, height, depth, border, format, type, pixels) => {
      if (GLctx.currentPixelUnpackBufferBinding) {
        GLctx.texImage3D(target, level, internalFormat, width, height, depth, border, format, type, pixels);
      } else if (pixels) {
        var heap = heapObjectForWebGLType(type);
        GLctx.texImage3D(target, level, internalFormat, width, height, depth, border, format, type, heap, toTypedArrayIndex(pixels, heap));
      } else {
        GLctx.texImage3D(target, level, internalFormat, width, height, depth, border, format, type, null);
      }
    };
  var _emscripten_glTexImage3D = _glTexImage3D;

  /** @suppress {duplicate } */
  var _glTexParameterf = (x0, x1, x2) => GLctx.texParameterf(x0, x1, x2);
  var _emscripten_glTexParameterf = _glTexParameterf;

  /** @suppress {duplicate } */
  var _glTexParameterfv = (target, pname, params) => {
      var param = HEAPF32[((params)>>2)];
      GLctx.texParameterf(target, pname, param);
    };
  var _emscripten_glTexParameterfv = _glTexParameterfv;

  /** @suppress {duplicate } */
  var _glTexParameteri = (x0, x1, x2) => GLctx.texParameteri(x0, x1, x2);
  var _emscripten_glTexParameteri = _glTexParameteri;

  /** @suppress {duplicate } */
  var _glTexParameteriv = (target, pname, params) => {
      var param = HEAP32[((params)>>2)];
      GLctx.texParameteri(target, pname, param);
    };
  var _emscripten_glTexParameteriv = _glTexParameteriv;

  /** @suppress {duplicate } */
  var _glTexStorage2D = (x0, x1, x2, x3, x4) => GLctx.texStorage2D(x0, x1, x2, x3, x4);
  var _emscripten_glTexStorage2D = _glTexStorage2D;

  /** @suppress {duplicate } */
  var _glTexStorage3D = (x0, x1, x2, x3, x4, x5) => GLctx.texStorage3D(x0, x1, x2, x3, x4, x5);
  var _emscripten_glTexStorage3D = _glTexStorage3D;

  
  
  
  /** @suppress {duplicate } */
  var _glTexSubImage2D = (target, level, xoffset, yoffset, width, height, format, type, pixels) => {
      if (true) {
        if (GLctx.currentPixelUnpackBufferBinding) {
          GLctx.texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixels);
          return;
        }
        if (pixels) {
          var heap = heapObjectForWebGLType(type);
          GLctx.texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, heap, toTypedArrayIndex(pixels, heap));
          return;
        }
      }
      var pixelData = pixels ? emscriptenWebGLGetTexPixelData(type, format, width, height, pixels, 0) : null;
      GLctx.texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixelData);
    };
  var _emscripten_glTexSubImage2D = _glTexSubImage2D;

  
  /** @suppress {duplicate } */
  var _glTexSubImage3D = (target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixels) => {
      if (GLctx.currentPixelUnpackBufferBinding) {
        GLctx.texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixels);
      } else if (pixels) {
        var heap = heapObjectForWebGLType(type);
        GLctx.texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, heap, toTypedArrayIndex(pixels, heap));
      } else {
        GLctx.texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, null);
      }
    };
  var _emscripten_glTexSubImage3D = _glTexSubImage3D;

  /** @suppress {duplicate } */
  var _glTransformFeedbackVaryings = (program, count, varyings, bufferMode) => {
      program = GL.programs[program];
      var vars = [];
      for (var i = 0; i < count; i++)
        vars.push(UTF8ToString(HEAP32[(((varyings)+(i*4))>>2)]));
  
      GLctx.transformFeedbackVaryings(program, vars, bufferMode);
    };
  var _emscripten_glTransformFeedbackVaryings = _glTransformFeedbackVaryings;

  
  /** @suppress {duplicate } */
  var _glUniform1f = (location, v0) => {
      GLctx.uniform1f(webglGetUniformLocation(location), v0);
    };
  var _emscripten_glUniform1f = _glUniform1f;

  
  /** @suppress {duplicate } */
  var _glUniform1fv = (location, count, value) => {
  
      count && GLctx.uniform1fv(webglGetUniformLocation(location), HEAPF32, ((value)>>2), count);
    };
  var _emscripten_glUniform1fv = _glUniform1fv;

  
  /** @suppress {duplicate } */
  var _glUniform1i = (location, v0) => {
      GLctx.uniform1i(webglGetUniformLocation(location), v0);
    };
  var _emscripten_glUniform1i = _glUniform1i;

  
  /** @suppress {duplicate } */
  var _glUniform1iv = (location, count, value) => {
  
      count && GLctx.uniform1iv(webglGetUniformLocation(location), HEAP32, ((value)>>2), count);
    };
  var _emscripten_glUniform1iv = _glUniform1iv;

  /** @suppress {duplicate } */
  var _glUniform1ui = (location, v0) => {
      GLctx.uniform1ui(webglGetUniformLocation(location), v0);
    };
  var _emscripten_glUniform1ui = _glUniform1ui;

  /** @suppress {duplicate } */
  var _glUniform1uiv = (location, count, value) => {
      count && GLctx.uniform1uiv(webglGetUniformLocation(location), HEAPU32, ((value)>>2), count);
    };
  var _emscripten_glUniform1uiv = _glUniform1uiv;

  
  /** @suppress {duplicate } */
  var _glUniform2f = (location, v0, v1) => {
      GLctx.uniform2f(webglGetUniformLocation(location), v0, v1);
    };
  var _emscripten_glUniform2f = _glUniform2f;

  
  /** @suppress {duplicate } */
  var _glUniform2fv = (location, count, value) => {
  
      count && GLctx.uniform2fv(webglGetUniformLocation(location), HEAPF32, ((value)>>2), count*2);
    };
  var _emscripten_glUniform2fv = _glUniform2fv;

  
  /** @suppress {duplicate } */
  var _glUniform2i = (location, v0, v1) => {
      GLctx.uniform2i(webglGetUniformLocation(location), v0, v1);
    };
  var _emscripten_glUniform2i = _glUniform2i;

  
  /** @suppress {duplicate } */
  var _glUniform2iv = (location, count, value) => {
  
      count && GLctx.uniform2iv(webglGetUniformLocation(location), HEAP32, ((value)>>2), count*2);
    };
  var _emscripten_glUniform2iv = _glUniform2iv;

  /** @suppress {duplicate } */
  var _glUniform2ui = (location, v0, v1) => {
      GLctx.uniform2ui(webglGetUniformLocation(location), v0, v1);
    };
  var _emscripten_glUniform2ui = _glUniform2ui;

  /** @suppress {duplicate } */
  var _glUniform2uiv = (location, count, value) => {
      count && GLctx.uniform2uiv(webglGetUniformLocation(location), HEAPU32, ((value)>>2), count*2);
    };
  var _emscripten_glUniform2uiv = _glUniform2uiv;

  
  /** @suppress {duplicate } */
  var _glUniform3f = (location, v0, v1, v2) => {
      GLctx.uniform3f(webglGetUniformLocation(location), v0, v1, v2);
    };
  var _emscripten_glUniform3f = _glUniform3f;

  
  /** @suppress {duplicate } */
  var _glUniform3fv = (location, count, value) => {
  
      count && GLctx.uniform3fv(webglGetUniformLocation(location), HEAPF32, ((value)>>2), count*3);
    };
  var _emscripten_glUniform3fv = _glUniform3fv;

  
  /** @suppress {duplicate } */
  var _glUniform3i = (location, v0, v1, v2) => {
      GLctx.uniform3i(webglGetUniformLocation(location), v0, v1, v2);
    };
  var _emscripten_glUniform3i = _glUniform3i;

  
  /** @suppress {duplicate } */
  var _glUniform3iv = (location, count, value) => {
  
      count && GLctx.uniform3iv(webglGetUniformLocation(location), HEAP32, ((value)>>2), count*3);
    };
  var _emscripten_glUniform3iv = _glUniform3iv;

  /** @suppress {duplicate } */
  var _glUniform3ui = (location, v0, v1, v2) => {
      GLctx.uniform3ui(webglGetUniformLocation(location), v0, v1, v2);
    };
  var _emscripten_glUniform3ui = _glUniform3ui;

  /** @suppress {duplicate } */
  var _glUniform3uiv = (location, count, value) => {
      count && GLctx.uniform3uiv(webglGetUniformLocation(location), HEAPU32, ((value)>>2), count*3);
    };
  var _emscripten_glUniform3uiv = _glUniform3uiv;

  
  /** @suppress {duplicate } */
  var _glUniform4f = (location, v0, v1, v2, v3) => {
      GLctx.uniform4f(webglGetUniformLocation(location), v0, v1, v2, v3);
    };
  var _emscripten_glUniform4f = _glUniform4f;

  
  /** @suppress {duplicate } */
  var _glUniform4fv = (location, count, value) => {
  
      count && GLctx.uniform4fv(webglGetUniformLocation(location), HEAPF32, ((value)>>2), count*4);
    };
  var _emscripten_glUniform4fv = _glUniform4fv;

  
  /** @suppress {duplicate } */
  var _glUniform4i = (location, v0, v1, v2, v3) => {
      GLctx.uniform4i(webglGetUniformLocation(location), v0, v1, v2, v3);
    };
  var _emscripten_glUniform4i = _glUniform4i;

  
  /** @suppress {duplicate } */
  var _glUniform4iv = (location, count, value) => {
  
      count && GLctx.uniform4iv(webglGetUniformLocation(location), HEAP32, ((value)>>2), count*4);
    };
  var _emscripten_glUniform4iv = _glUniform4iv;

  /** @suppress {duplicate } */
  var _glUniform4ui = (location, v0, v1, v2, v3) => {
      GLctx.uniform4ui(webglGetUniformLocation(location), v0, v1, v2, v3);
    };
  var _emscripten_glUniform4ui = _glUniform4ui;

  /** @suppress {duplicate } */
  var _glUniform4uiv = (location, count, value) => {
      count && GLctx.uniform4uiv(webglGetUniformLocation(location), HEAPU32, ((value)>>2), count*4);
    };
  var _emscripten_glUniform4uiv = _glUniform4uiv;

  /** @suppress {duplicate } */
  var _glUniformBlockBinding = (program, uniformBlockIndex, uniformBlockBinding) => {
      program = GL.programs[program];
  
      GLctx.uniformBlockBinding(program, uniformBlockIndex, uniformBlockBinding);
    };
  var _emscripten_glUniformBlockBinding = _glUniformBlockBinding;

  
  /** @suppress {duplicate } */
  var _glUniformMatrix2fv = (location, count, transpose, value) => {
  
      count && GLctx.uniformMatrix2fv(webglGetUniformLocation(location), !!transpose, HEAPF32, ((value)>>2), count*4);
    };
  var _emscripten_glUniformMatrix2fv = _glUniformMatrix2fv;

  /** @suppress {duplicate } */
  var _glUniformMatrix2x3fv = (location, count, transpose, value) => {
      count && GLctx.uniformMatrix2x3fv(webglGetUniformLocation(location), !!transpose, HEAPF32, ((value)>>2), count*6);
    };
  var _emscripten_glUniformMatrix2x3fv = _glUniformMatrix2x3fv;

  /** @suppress {duplicate } */
  var _glUniformMatrix2x4fv = (location, count, transpose, value) => {
      count && GLctx.uniformMatrix2x4fv(webglGetUniformLocation(location), !!transpose, HEAPF32, ((value)>>2), count*8);
    };
  var _emscripten_glUniformMatrix2x4fv = _glUniformMatrix2x4fv;

  
  /** @suppress {duplicate } */
  var _glUniformMatrix3fv = (location, count, transpose, value) => {
  
      count && GLctx.uniformMatrix3fv(webglGetUniformLocation(location), !!transpose, HEAPF32, ((value)>>2), count*9);
    };
  var _emscripten_glUniformMatrix3fv = _glUniformMatrix3fv;

  /** @suppress {duplicate } */
  var _glUniformMatrix3x2fv = (location, count, transpose, value) => {
      count && GLctx.uniformMatrix3x2fv(webglGetUniformLocation(location), !!transpose, HEAPF32, ((value)>>2), count*6);
    };
  var _emscripten_glUniformMatrix3x2fv = _glUniformMatrix3x2fv;

  /** @suppress {duplicate } */
  var _glUniformMatrix3x4fv = (location, count, transpose, value) => {
      count && GLctx.uniformMatrix3x4fv(webglGetUniformLocation(location), !!transpose, HEAPF32, ((value)>>2), count*12);
    };
  var _emscripten_glUniformMatrix3x4fv = _glUniformMatrix3x4fv;

  
  /** @suppress {duplicate } */
  var _glUniformMatrix4fv = (location, count, transpose, value) => {
  
      count && GLctx.uniformMatrix4fv(webglGetUniformLocation(location), !!transpose, HEAPF32, ((value)>>2), count*16);
    };
  var _emscripten_glUniformMatrix4fv = _glUniformMatrix4fv;

  /** @suppress {duplicate } */
  var _glUniformMatrix4x2fv = (location, count, transpose, value) => {
      count && GLctx.uniformMatrix4x2fv(webglGetUniformLocation(location), !!transpose, HEAPF32, ((value)>>2), count*8);
    };
  var _emscripten_glUniformMatrix4x2fv = _glUniformMatrix4x2fv;

  /** @suppress {duplicate } */
  var _glUniformMatrix4x3fv = (location, count, transpose, value) => {
      count && GLctx.uniformMatrix4x3fv(webglGetUniformLocation(location), !!transpose, HEAPF32, ((value)>>2), count*12);
    };
  var _emscripten_glUniformMatrix4x3fv = _glUniformMatrix4x3fv;

  /** @suppress {duplicate } */
  var _glUseProgram = (program) => {
      program = GL.programs[program];
      GLctx.useProgram(program);
      // Record the currently active program so that we can access the uniform
      // mapping table of that program.
      GLctx.currentProgram = program;
    };
  var _emscripten_glUseProgram = _glUseProgram;

  /** @suppress {duplicate } */
  var _glValidateProgram = (program) => {
      GLctx.validateProgram(GL.programs[program]);
    };
  var _emscripten_glValidateProgram = _glValidateProgram;

  /** @suppress {duplicate } */
  var _glVertexAttrib1f = (x0, x1) => GLctx.vertexAttrib1f(x0, x1);
  var _emscripten_glVertexAttrib1f = _glVertexAttrib1f;

  /** @suppress {duplicate } */
  var _glVertexAttrib1fv = (index, v) => {
  
      GLctx.vertexAttrib1f(index, HEAPF32[v>>2]);
    };
  var _emscripten_glVertexAttrib1fv = _glVertexAttrib1fv;

  /** @suppress {duplicate } */
  var _glVertexAttrib2f = (x0, x1, x2) => GLctx.vertexAttrib2f(x0, x1, x2);
  var _emscripten_glVertexAttrib2f = _glVertexAttrib2f;

  /** @suppress {duplicate } */
  var _glVertexAttrib2fv = (index, v) => {
  
      GLctx.vertexAttrib2f(index, HEAPF32[v>>2], HEAPF32[v+4>>2]);
    };
  var _emscripten_glVertexAttrib2fv = _glVertexAttrib2fv;

  /** @suppress {duplicate } */
  var _glVertexAttrib3f = (x0, x1, x2, x3) => GLctx.vertexAttrib3f(x0, x1, x2, x3);
  var _emscripten_glVertexAttrib3f = _glVertexAttrib3f;

  /** @suppress {duplicate } */
  var _glVertexAttrib3fv = (index, v) => {
  
      GLctx.vertexAttrib3f(index, HEAPF32[v>>2], HEAPF32[v+4>>2], HEAPF32[v+8>>2]);
    };
  var _emscripten_glVertexAttrib3fv = _glVertexAttrib3fv;

  /** @suppress {duplicate } */
  var _glVertexAttrib4f = (x0, x1, x2, x3, x4) => GLctx.vertexAttrib4f(x0, x1, x2, x3, x4);
  var _emscripten_glVertexAttrib4f = _glVertexAttrib4f;

  /** @suppress {duplicate } */
  var _glVertexAttrib4fv = (index, v) => {
  
      GLctx.vertexAttrib4f(index, HEAPF32[v>>2], HEAPF32[v+4>>2], HEAPF32[v+8>>2], HEAPF32[v+12>>2]);
    };
  var _emscripten_glVertexAttrib4fv = _glVertexAttrib4fv;

  /** @suppress {duplicate } */
  var _glVertexAttribDivisor = (index, divisor) => {
      GLctx.vertexAttribDivisor(index, divisor);
    };
  var _emscripten_glVertexAttribDivisor = _glVertexAttribDivisor;

  
  /** @suppress {duplicate } */
  var _glVertexAttribDivisorANGLE = _glVertexAttribDivisor;
  var _emscripten_glVertexAttribDivisorANGLE = _glVertexAttribDivisorANGLE;

  
  /** @suppress {duplicate } */
  var _glVertexAttribDivisorARB = _glVertexAttribDivisor;
  var _emscripten_glVertexAttribDivisorARB = _glVertexAttribDivisorARB;

  
  /** @suppress {duplicate } */
  var _glVertexAttribDivisorEXT = _glVertexAttribDivisor;
  var _emscripten_glVertexAttribDivisorEXT = _glVertexAttribDivisorEXT;

  
  /** @suppress {duplicate } */
  var _glVertexAttribDivisorNV = _glVertexAttribDivisor;
  var _emscripten_glVertexAttribDivisorNV = _glVertexAttribDivisorNV;

  /** @suppress {duplicate } */
  var _glVertexAttribI4i = (x0, x1, x2, x3, x4) => GLctx.vertexAttribI4i(x0, x1, x2, x3, x4);
  var _emscripten_glVertexAttribI4i = _glVertexAttribI4i;

  /** @suppress {duplicate } */
  var _glVertexAttribI4iv = (index, v) => {
      GLctx.vertexAttribI4i(index, HEAP32[v>>2], HEAP32[v+4>>2], HEAP32[v+8>>2], HEAP32[v+12>>2]);
    };
  var _emscripten_glVertexAttribI4iv = _glVertexAttribI4iv;

  /** @suppress {duplicate } */
  var _glVertexAttribI4ui = (x0, x1, x2, x3, x4) => GLctx.vertexAttribI4ui(x0, x1, x2, x3, x4);
  var _emscripten_glVertexAttribI4ui = _glVertexAttribI4ui;

  /** @suppress {duplicate } */
  var _glVertexAttribI4uiv = (index, v) => {
      GLctx.vertexAttribI4ui(index, HEAPU32[v>>2], HEAPU32[v+4>>2], HEAPU32[v+8>>2], HEAPU32[v+12>>2]);
    };
  var _emscripten_glVertexAttribI4uiv = _glVertexAttribI4uiv;

  /** @suppress {duplicate } */
  var _glVertexAttribIPointer = (index, size, type, stride, ptr) => {
      GLctx.vertexAttribIPointer(index, size, type, stride, ptr);
    };
  var _emscripten_glVertexAttribIPointer = _glVertexAttribIPointer;

  /** @suppress {duplicate } */
  var _glVertexAttribPointer = (index, size, type, normalized, stride, ptr) => {
      GLctx.vertexAttribPointer(index, size, type, !!normalized, stride, ptr);
    };
  var _emscripten_glVertexAttribPointer = _glVertexAttribPointer;

  /** @suppress {duplicate } */
  var _glViewport = (x0, x1, x2, x3) => GLctx.viewport(x0, x1, x2, x3);
  var _emscripten_glViewport = _glViewport;

  /** @suppress {duplicate } */
  var _glWaitSync = (sync, flags, timeout) => {
      // See WebGL2 vs GLES3 difference on GL_TIMEOUT_IGNORED above (https://www.khronos.org/registry/webgl/specs/latest/2.0/#5.15)
      timeout = Number(timeout);
      GLctx.waitSync(GL.syncs[sync], flags, timeout);
    };
  var _emscripten_glWaitSync = _glWaitSync;

  var _emscripten_has_asyncify = () => 0;

  var _emscripten_num_logical_cores = () =>
      ENVIRONMENT_IS_NODE ? require('os').cpus().length :
      navigator['hardwareConcurrency'];

  
  
  
  
  
  
  
  var doRequestFullscreen = (target, strategy) => {
      if (!JSEvents.fullscreenEnabled()) return -1;
      target = findEventTarget(target);
      if (!target) return -4;
  
      if (!target.requestFullscreen
        && !target.webkitRequestFullscreen
        ) {
        return -3;
      }
  
      var canPerformRequests = JSEvents.canPerformEventHandlerRequests();
  
      // Queue this function call if we're not currently in an event handler and the user saw it appropriate to do so.
      if (!canPerformRequests) {
        if (strategy.deferUntilInEventHandler) {
          JSEvents.deferCall(JSEvents_requestFullscreen, 1 /* priority over pointer lock */, [target, strategy]);
          return 1;
        }
        return -2;
      }
  
      return JSEvents_requestFullscreen(target, strategy);
    };
  
  
  
  
  function _emscripten_request_fullscreen_strategy(target, deferUntilInEventHandler, fullscreenStrategy) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(47, 0, 1, target, deferUntilInEventHandler, fullscreenStrategy);
  
      var strategy = {
        scaleMode: HEAP32[((fullscreenStrategy)>>2)],
        canvasResolutionScaleMode: HEAP32[(((fullscreenStrategy)+(4))>>2)],
        filteringMode: HEAP32[(((fullscreenStrategy)+(8))>>2)],
        deferUntilInEventHandler,
        canvasResizedCallbackTargetThread: HEAP32[(((fullscreenStrategy)+(20))>>2)],
        canvasResizedCallback: HEAP32[(((fullscreenStrategy)+(12))>>2)],
        canvasResizedCallbackUserData: HEAP32[(((fullscreenStrategy)+(16))>>2)]
      };
  
      return doRequestFullscreen(target, strategy);
    
  }
  

  
  
  
  
  function _emscripten_request_pointerlock(target, deferUntilInEventHandler) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(48, 0, 1, target, deferUntilInEventHandler);
  
      target = findEventTarget(target);
      if (!target) return -4;
      if (!target.requestPointerLock
        ) {
        return -1;
      }
  
      var canPerformRequests = JSEvents.canPerformEventHandlerRequests();
  
      // Queue this function call if we're not currently in an event handler and the user saw it appropriate to do so.
      if (!canPerformRequests) {
        if (deferUntilInEventHandler) {
          JSEvents.deferCall(requestPointerLock, 2 /* priority below fullscreen */, [target]);
          return 1;
        }
        return -2;
      }
  
      return requestPointerLock(target);
    
  }
  

  
  var abortOnCannotGrowMemory = (requestedSize) => {
      abort('OOM');
    };
  var _emscripten_resize_heap = (requestedSize) => {
      var oldSize = HEAPU8.length;
      // With CAN_ADDRESS_2GB or MEMORY64, pointers are already unsigned.
      requestedSize >>>= 0;
      abortOnCannotGrowMemory(requestedSize);
    };

  
  /** @suppress {checkTypes} */
  
  function _emscripten_sample_gamepad_data() {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(49, 0, 1);
  
      try {
        if (navigator.getGamepads) return (JSEvents.lastGamepadState = navigator.getGamepads())
          ? 0 : -1;
      } catch(e) {
        navigator.getGamepads = null; // Disable getGamepads() so that it won't be attempted to be used again.
      }
      return -1;
    
  }
  

  
  
  
  var registerBeforeUnloadEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString) => {
      var beforeUnloadEventHandlerFunc = (e = event) => {
        // Note: This is always called on the main browser thread, since it needs synchronously return a value!
        var confirmationMessage = getWasmTableEntry(callbackfunc)(eventTypeId, 0, userData);
  
        if (confirmationMessage) {
          confirmationMessage = UTF8ToString(confirmationMessage);
        }
        if (confirmationMessage) {
          e.preventDefault();
          e.returnValue = confirmationMessage;
          return confirmationMessage;
        }
      };
  
      var eventHandler = {
        target: findEventTarget(target),
        eventTypeString,
        callbackfunc,
        handlerFunc: beforeUnloadEventHandlerFunc,
        useCapture
      };
      return JSEvents.registerOrRemoveHandler(eventHandler);
    };
  
  
  function _emscripten_set_beforeunload_callback_on_thread(userData, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(50, 0, 1, userData, callbackfunc, targetThread);
  
      if (typeof onbeforeunload == 'undefined') return -1;
      // beforeunload callback can only be registered on the main browser thread, because the page will go away immediately after returning from the handler,
      // and there is no time to start proxying it anywhere.
      if (targetThread !== 1) return -5;
      return registerBeforeUnloadEventCallback(2, userData, true, callbackfunc, 28, "beforeunload");
    
  }
  

  
  
  
  
  var registerFocusEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
      targetThread = JSEvents.getTargetThreadForEventCallback(targetThread);
      if (!JSEvents.focusEvent) JSEvents.focusEvent = _malloc(256);
  
      var focusEventHandlerFunc = (e = event) => {
        var nodeName = JSEvents.getNodeNameForTarget(e.target);
        var id = e.target.id ? e.target.id : '';
  
        var focusEvent = targetThread ? _malloc(256) : JSEvents.focusEvent;
        stringToUTF8(nodeName, focusEvent + 0, 128);
        stringToUTF8(id, focusEvent + 128, 128);
  
        if (targetThread) __emscripten_run_callback_on_thread(targetThread, callbackfunc, eventTypeId, focusEvent, userData);
        else
        if (getWasmTableEntry(callbackfunc)(eventTypeId, focusEvent, userData)) e.preventDefault();
      };
  
      var eventHandler = {
        target: findEventTarget(target),
        eventTypeString,
        callbackfunc,
        handlerFunc: focusEventHandlerFunc,
        useCapture
      };
      return JSEvents.registerOrRemoveHandler(eventHandler);
    };
  
  
  function _emscripten_set_blur_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(51, 0, 1, target, userData, useCapture, callbackfunc, targetThread);
  return registerFocusEventCallback(target, userData, useCapture, callbackfunc, 12, "blur", targetThread)
  }
  


  
  var fillDeviceMotionEventData = (eventStruct, e, target) => {
      var supportedFields = 0;
      var a = e['acceleration'];
      supportedFields |= a && 1;
      var ag = e['accelerationIncludingGravity'];
      supportedFields |= ag && 2;
      var rr = e['rotationRate'];
      supportedFields |= rr && 4;
      a = a || {};
      ag = ag || {};
      rr = rr || {};
      HEAPF64[((eventStruct)>>3)] = a["x"];
      HEAPF64[(((eventStruct)+(8))>>3)] = a["y"];
      HEAPF64[(((eventStruct)+(16))>>3)] = a["z"];
      HEAPF64[(((eventStruct)+(24))>>3)] = ag["x"];
      HEAPF64[(((eventStruct)+(32))>>3)] = ag["y"];
      HEAPF64[(((eventStruct)+(40))>>3)] = ag["z"];
      HEAPF64[(((eventStruct)+(48))>>3)] = rr["alpha"];
      HEAPF64[(((eventStruct)+(56))>>3)] = rr["beta"];
      HEAPF64[(((eventStruct)+(64))>>3)] = rr["gamma"];
    };
  
  
  
  var registerDeviceMotionEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
      targetThread = JSEvents.getTargetThreadForEventCallback(targetThread);
      if (!JSEvents.deviceMotionEvent) JSEvents.deviceMotionEvent = _malloc(80);
  
      var deviceMotionEventHandlerFunc = (e = event) => {
        fillDeviceMotionEventData(JSEvents.deviceMotionEvent, e, target); // TODO: Thread-safety with respect to emscripten_get_devicemotion_status()
  
        if (targetThread) {
          var deviceMotionEvent = _malloc(80);
          fillDeviceMotionEventData(deviceMotionEvent, e, target);
          __emscripten_run_callback_on_thread(targetThread, callbackfunc, eventTypeId, deviceMotionEvent, userData);
        } else
        if (getWasmTableEntry(callbackfunc)(eventTypeId, JSEvents.deviceMotionEvent, userData)) e.preventDefault();
      };
  
      var eventHandler = {
        target: findEventTarget(target),
        eventTypeString,
        callbackfunc,
        handlerFunc: deviceMotionEventHandlerFunc,
        useCapture
      };
      return JSEvents.registerOrRemoveHandler(eventHandler);
    };
  
  
  function _emscripten_set_devicemotion_callback_on_thread(userData, useCapture, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(52, 0, 1, userData, useCapture, callbackfunc, targetThread);
  
      return registerDeviceMotionEventCallback(2, userData, useCapture, callbackfunc, 17, "devicemotion", targetThread);
    
  }
  

  
  
  
  function _emscripten_set_element_css_size(target, width, height) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(53, 0, 1, target, width, height);
  
      target = findEventTarget(target);
      if (!target) return -4;
  
      target.style.width = width + "px";
      target.style.height = height + "px";
  
      return 0;
    
  }
  

  
  
  function _emscripten_set_focus_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(54, 0, 1, target, userData, useCapture, callbackfunc, targetThread);
  return registerFocusEventCallback(target, userData, useCapture, callbackfunc, 13, "focus", targetThread)
  }
  

  
  
  
  
  
  var registerFullscreenChangeEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
      targetThread = JSEvents.getTargetThreadForEventCallback(targetThread);
      if (!JSEvents.fullscreenChangeEvent) JSEvents.fullscreenChangeEvent = _malloc(280);
  
      var fullscreenChangeEventhandlerFunc = (e = event) => {
        var fullscreenChangeEvent = targetThread ? _malloc(280) : JSEvents.fullscreenChangeEvent;
  
        fillFullscreenChangeEventData(fullscreenChangeEvent);
  
        if (targetThread) __emscripten_run_callback_on_thread(targetThread, callbackfunc, eventTypeId, fullscreenChangeEvent, userData);
        else
        if (getWasmTableEntry(callbackfunc)(eventTypeId, fullscreenChangeEvent, userData)) e.preventDefault();
      };
  
      var eventHandler = {
        target,
        eventTypeString,
        callbackfunc,
        handlerFunc: fullscreenChangeEventhandlerFunc,
        useCapture
      };
      return JSEvents.registerOrRemoveHandler(eventHandler);
    };
  
  
  
  
  function _emscripten_set_fullscreenchange_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(55, 0, 1, target, userData, useCapture, callbackfunc, targetThread);
  
      if (!JSEvents.fullscreenEnabled()) return -1;
      target = findEventTarget(target);
      if (!target) return -4;
  
      // Unprefixed Fullscreen API shipped in Chromium 71 (https://bugs.chromium.org/p/chromium/issues/detail?id=383813)
      // As of Safari 13.0.3 on macOS Catalina 10.15.1 still ships with prefixed webkitfullscreenchange. TODO: revisit this check once Safari ships unprefixed version.
      registerFullscreenChangeEventCallback(target, userData, useCapture, callbackfunc, 19, "webkitfullscreenchange", targetThread);
  
      return registerFullscreenChangeEventCallback(target, userData, useCapture, callbackfunc, 19, "fullscreenchange", targetThread);
    
  }
  

  
  
  
  
  var registerGamepadEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
      targetThread = JSEvents.getTargetThreadForEventCallback(targetThread);
      if (!JSEvents.gamepadEvent) JSEvents.gamepadEvent = _malloc(1432);
  
      var gamepadEventHandlerFunc = (e = event) => {
        var gamepadEvent = targetThread ? _malloc(1432) : JSEvents.gamepadEvent;
        fillGamepadEventData(gamepadEvent, e["gamepad"]);
  
        if (targetThread) __emscripten_run_callback_on_thread(targetThread, callbackfunc, eventTypeId, gamepadEvent, userData);
        else
        if (getWasmTableEntry(callbackfunc)(eventTypeId, gamepadEvent, userData)) e.preventDefault();
      };
  
      var eventHandler = {
        target: findEventTarget(target),
        allowsDeferredCalls: true,
        eventTypeString,
        callbackfunc,
        handlerFunc: gamepadEventHandlerFunc,
        useCapture
      };
      return JSEvents.registerOrRemoveHandler(eventHandler);
    };
  
  
  
  function _emscripten_set_gamepadconnected_callback_on_thread(userData, useCapture, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(56, 0, 1, userData, useCapture, callbackfunc, targetThread);
  
      if (_emscripten_sample_gamepad_data()) return -1;
      return registerGamepadEventCallback(2, userData, useCapture, callbackfunc, 26, "gamepadconnected", targetThread);
    
  }
  

  
  
  
  function _emscripten_set_gamepaddisconnected_callback_on_thread(userData, useCapture, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(57, 0, 1, userData, useCapture, callbackfunc, targetThread);
  
      if (_emscripten_sample_gamepad_data()) return -1;
      return registerGamepadEventCallback(2, userData, useCapture, callbackfunc, 27, "gamepaddisconnected", targetThread);
    
  }
  

  
  
  
  
  var registerKeyEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
      targetThread = JSEvents.getTargetThreadForEventCallback(targetThread);
      if (!JSEvents.keyEvent) JSEvents.keyEvent = _malloc(176);
  
      var keyEventHandlerFunc = (e) => {
  
        var keyEventData = targetThread ? _malloc(176) : JSEvents.keyEvent; // This allocated block is passed as satellite data to the proxied function call, so the call frees up the data block when done.
        HEAPF64[((keyEventData)>>3)] = e.timeStamp;
  
        var idx =((keyEventData)>>2);
  
        HEAP32[idx + 2] = e.location;
        HEAP32[idx + 3] = e.ctrlKey;
        HEAP32[idx + 4] = e.shiftKey;
        HEAP32[idx + 5] = e.altKey;
        HEAP32[idx + 6] = e.metaKey;
        HEAP32[idx + 7] = e.repeat;
        HEAP32[idx + 8] = e.charCode;
        HEAP32[idx + 9] = e.keyCode;
        HEAP32[idx + 10] = e.which;
        stringToUTF8(e.key || '', keyEventData + 44, 32);
        stringToUTF8(e.code || '', keyEventData + 76, 32);
        stringToUTF8(e.char || '', keyEventData + 108, 32);
        stringToUTF8(e.locale || '', keyEventData + 140, 32);
  
        if (targetThread) __emscripten_run_callback_on_thread(targetThread, callbackfunc, eventTypeId, keyEventData, userData);
        else
        if (getWasmTableEntry(callbackfunc)(eventTypeId, keyEventData, userData)) e.preventDefault();
      };
  
      var eventHandler = {
        target: findEventTarget(target),
        eventTypeString,
        callbackfunc,
        handlerFunc: keyEventHandlerFunc,
        useCapture
      };
      return JSEvents.registerOrRemoveHandler(eventHandler);
    };
  
  
  function _emscripten_set_keydown_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(58, 0, 1, target, userData, useCapture, callbackfunc, targetThread);
  return registerKeyEventCallback(target, userData, useCapture, callbackfunc, 2, "keydown", targetThread)
  }
  

  
  
  function _emscripten_set_keypress_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(59, 0, 1, target, userData, useCapture, callbackfunc, targetThread);
  return registerKeyEventCallback(target, userData, useCapture, callbackfunc, 1, "keypress", targetThread)
  }
  

  
  
  function _emscripten_set_keyup_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(60, 0, 1, target, userData, useCapture, callbackfunc, targetThread);
  return registerKeyEventCallback(target, userData, useCapture, callbackfunc, 3, "keyup", targetThread)
  }
  

  
  
  var _emscripten_set_main_loop = (func, fps, simulateInfiniteLoop) => {
      var browserIterationFunc = getWasmTableEntry(func);
      setMainLoop(browserIterationFunc, fps, simulateInfiniteLoop);
    };


  
  var screenOrientation = () => {
      if (!window.screen) return undefined;
      return screen.orientation || screen['mozOrientation'] || screen['webkitOrientation'];
    };
  var fillOrientationChangeEventData = (eventStruct) => {
      // OrientationType enum
      var orientationsType1 = ['portrait-primary', 'portrait-secondary', 'landscape-primary', 'landscape-secondary'];
      // alternative selection from OrientationLockType enum
      var orientationsType2 = ['portrait',         'portrait',           'landscape',         'landscape'];
  
      var orientationIndex = 0;
      var orientationAngle = 0;
      var screenOrientObj  = screenOrientation();
      if (typeof screenOrientObj === 'object') {
        orientationIndex = orientationsType1.indexOf(screenOrientObj.type);
        if (orientationIndex < 0) {
          orientationIndex = orientationsType2.indexOf(screenOrientObj.type);
        }
        if (orientationIndex >= 0) {
          orientationIndex = 1 << orientationIndex;
        }
        orientationAngle = screenOrientObj.angle;
      }
      else {
        // fallback for Safari earlier than 16.4 (March 2023)
        orientationAngle = window.orientation;
      }
  
      HEAP32[((eventStruct)>>2)] = orientationIndex;
      HEAP32[(((eventStruct)+(4))>>2)] = orientationAngle;
    };
  
  
  
  var registerOrientationChangeEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
      targetThread = JSEvents.getTargetThreadForEventCallback(targetThread);
      if (!JSEvents.orientationChangeEvent) JSEvents.orientationChangeEvent = _malloc(8);
  
      var orientationChangeEventHandlerFunc = (e = event) => {
        var orientationChangeEvent = targetThread ? _malloc(8) : JSEvents.orientationChangeEvent;
  
        fillOrientationChangeEventData(orientationChangeEvent);
  
        if (targetThread) __emscripten_run_callback_on_thread(targetThread, callbackfunc, eventTypeId, orientationChangeEvent, userData);
        else
        if (getWasmTableEntry(callbackfunc)(eventTypeId, orientationChangeEvent, userData)) e.preventDefault();
      };
  
      var eventHandler = {
        target,
        eventTypeString,
        callbackfunc,
        handlerFunc: orientationChangeEventHandlerFunc,
        useCapture
      };
      return JSEvents.registerOrRemoveHandler(eventHandler);
    };
  
  
  function _emscripten_set_orientationchange_callback_on_thread(userData, useCapture, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(61, 0, 1, userData, useCapture, callbackfunc, targetThread);
  
      if (!window.screen || !screen.orientation) return -1;
      return registerOrientationChangeEventCallback(screen.orientation, userData, useCapture, callbackfunc, 18, 'change', targetThread);
    
  }
  

  
  
  
  var fillPointerlockChangeEventData = (eventStruct) => {
      var pointerLockElement = document.pointerLockElement || document.mozPointerLockElement || document.webkitPointerLockElement || document.msPointerLockElement;
      var isPointerlocked = !!pointerLockElement;
      // Assigning a boolean to HEAP32 with expected type coercion.
      /** @suppress{checkTypes} */
      HEAP32[((eventStruct)>>2)] = isPointerlocked;
      var nodeName = JSEvents.getNodeNameForTarget(pointerLockElement);
      var id = pointerLockElement?.id || '';
      stringToUTF8(nodeName, eventStruct + 4, 128);
      stringToUTF8(id, eventStruct + 132, 128);
    };
  
  
  
  var registerPointerlockChangeEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
      targetThread = JSEvents.getTargetThreadForEventCallback(targetThread);
      if (!JSEvents.pointerlockChangeEvent) JSEvents.pointerlockChangeEvent = _malloc(260);
  
      var pointerlockChangeEventHandlerFunc = (e = event) => {
        var pointerlockChangeEvent = targetThread ? _malloc(260) : JSEvents.pointerlockChangeEvent;
        fillPointerlockChangeEventData(pointerlockChangeEvent);
  
        if (targetThread) __emscripten_run_callback_on_thread(targetThread, callbackfunc, eventTypeId, pointerlockChangeEvent, userData);
        else
        if (getWasmTableEntry(callbackfunc)(eventTypeId, pointerlockChangeEvent, userData)) e.preventDefault();
      };
  
      var eventHandler = {
        target,
        eventTypeString,
        callbackfunc,
        handlerFunc: pointerlockChangeEventHandlerFunc,
        useCapture
      };
      return JSEvents.registerOrRemoveHandler(eventHandler);
    };
  
  
  
  /** @suppress {missingProperties} */
  
  function _emscripten_set_pointerlockchange_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(62, 0, 1, target, userData, useCapture, callbackfunc, targetThread);
  
      // TODO: Currently not supported in pthreads or in --proxy-to-worker mode. (In pthreads mode, document object is not defined)
      if (!document || !document.body || (!document.body.requestPointerLock && !document.body.mozRequestPointerLock && !document.body.webkitRequestPointerLock && !document.body.msRequestPointerLock)) {
        return -1;
      }
  
      target = findEventTarget(target);
      if (!target) return -4;
      registerPointerlockChangeEventCallback(target, userData, useCapture, callbackfunc, 20, "mozpointerlockchange", targetThread);
      registerPointerlockChangeEventCallback(target, userData, useCapture, callbackfunc, 20, "webkitpointerlockchange", targetThread);
      registerPointerlockChangeEventCallback(target, userData, useCapture, callbackfunc, 20, "mspointerlockchange", targetThread);
      return registerPointerlockChangeEventCallback(target, userData, useCapture, callbackfunc, 20, "pointerlockchange", targetThread);
    
  }
  

  
  
  
  var registerUiEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
      targetThread = JSEvents.getTargetThreadForEventCallback(targetThread);
      if (!JSEvents.uiEvent) JSEvents.uiEvent = _malloc(36);
  
      target = findEventTarget(target);
  
      var uiEventHandlerFunc = (e = event) => {
        if (e.target != target) {
          // Never take ui events such as scroll via a 'bubbled' route, but always from the direct element that
          // was targeted. Otherwise e.g. if app logs a message in response to a page scroll, the Emscripten log
          // message box could cause to scroll, generating a new (bubbled) scroll message, causing a new log print,
          // causing a new scroll, etc..
          return;
        }
        var b = document.body; // Take document.body to a variable, Closure compiler does not outline access to it on its own.
        if (!b) {
          // During a page unload 'body' can be null, with "Cannot read property 'clientWidth' of null" being thrown
          return;
        }
        var uiEvent = targetThread ? _malloc(36) : JSEvents.uiEvent;
        HEAP32[((uiEvent)>>2)] = 0; // always zero for resize and scroll
        HEAP32[(((uiEvent)+(4))>>2)] = b.clientWidth;
        HEAP32[(((uiEvent)+(8))>>2)] = b.clientHeight;
        HEAP32[(((uiEvent)+(12))>>2)] = innerWidth;
        HEAP32[(((uiEvent)+(16))>>2)] = innerHeight;
        HEAP32[(((uiEvent)+(20))>>2)] = outerWidth;
        HEAP32[(((uiEvent)+(24))>>2)] = outerHeight;
        HEAP32[(((uiEvent)+(28))>>2)] = pageXOffset | 0; // scroll offsets are float
        HEAP32[(((uiEvent)+(32))>>2)] = pageYOffset | 0;
        if (targetThread) __emscripten_run_callback_on_thread(targetThread, callbackfunc, eventTypeId, uiEvent, userData);
        else
        if (getWasmTableEntry(callbackfunc)(eventTypeId, uiEvent, userData)) e.preventDefault();
      };
  
      var eventHandler = {
        target,
        eventTypeString,
        callbackfunc,
        handlerFunc: uiEventHandlerFunc,
        useCapture
      };
      return JSEvents.registerOrRemoveHandler(eventHandler);
    };
  
  
  function _emscripten_set_resize_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(63, 0, 1, target, userData, useCapture, callbackfunc, targetThread);
  return registerUiEventCallback(target, userData, useCapture, callbackfunc, 10, "resize", targetThread)
  }
  

  
  var _emscripten_set_timeout = (cb, msecs, userData) =>
      safeSetTimeout(() => getWasmTableEntry(cb)(userData), msecs);

  
  var fillVisibilityChangeEventData = (eventStruct) => {
      var visibilityStates = [ "hidden", "visible", "prerender", "unloaded" ];
      var visibilityState = visibilityStates.indexOf(document.visibilityState);
  
      // Assigning a boolean to HEAP32 with expected type coercion.
      /** @suppress{checkTypes} */
      HEAP32[((eventStruct)>>2)] = document.hidden;
      HEAP32[(((eventStruct)+(4))>>2)] = visibilityState;
    };
  
  
  
  var registerVisibilityChangeEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
      targetThread = JSEvents.getTargetThreadForEventCallback(targetThread);
      if (!JSEvents.visibilityChangeEvent) JSEvents.visibilityChangeEvent = _malloc(8);
  
      var visibilityChangeEventHandlerFunc = (e = event) => {
        var visibilityChangeEvent = targetThread ? _malloc(8) : JSEvents.visibilityChangeEvent;
  
        fillVisibilityChangeEventData(visibilityChangeEvent);
  
        if (targetThread) __emscripten_run_callback_on_thread(targetThread, callbackfunc, eventTypeId, visibilityChangeEvent, userData);
        else
        if (getWasmTableEntry(callbackfunc)(eventTypeId, visibilityChangeEvent, userData)) e.preventDefault();
      };
  
      var eventHandler = {
        target,
        eventTypeString,
        callbackfunc,
        handlerFunc: visibilityChangeEventHandlerFunc,
        useCapture
      };
      return JSEvents.registerOrRemoveHandler(eventHandler);
    };
  
  
  
  function _emscripten_set_visibilitychange_callback_on_thread(userData, useCapture, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(64, 0, 1, userData, useCapture, callbackfunc, targetThread);
  
    if (!specialHTMLTargets[1]) {
      return -4;
    }
      return registerVisibilityChangeEventCallback(specialHTMLTargets[1], userData, useCapture, callbackfunc, 21, "visibilitychange", targetThread);
    
  }
  

  
  
  
  
  var fillMouseEventData = (eventStruct, e, target) => {
      HEAPF64[((eventStruct)>>3)] = e.timeStamp;
      var idx = ((eventStruct)>>2);
      HEAP32[idx + 2] = e.screenX;
      HEAP32[idx + 3] = e.screenY;
      HEAP32[idx + 4] = e.clientX;
      HEAP32[idx + 5] = e.clientY;
      HEAP32[idx + 6] = e.ctrlKey;
      HEAP32[idx + 7] = e.shiftKey;
      HEAP32[idx + 8] = e.altKey;
      HEAP32[idx + 9] = e.metaKey;
      HEAP16[idx*2 + 20] = e.button;
      HEAP16[idx*2 + 21] = e.buttons;
  
      HEAP32[idx + 11] = e["movementX"]
        ;
  
      HEAP32[idx + 12] = e["movementY"]
        ;
  
      // Note: rect contains doubles (truncated to placate SAFE_HEAP, which is the same behaviour when writing to HEAP32 anyway)
      var rect = getBoundingClientRect(target);
      HEAP32[idx + 13] = e.clientX - (rect.left | 0);
      HEAP32[idx + 14] = e.clientY - (rect.top  | 0);
  
    };
  
  
  
  var registerWheelEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
      targetThread = JSEvents.getTargetThreadForEventCallback(targetThread);
      if (!JSEvents.wheelEvent) JSEvents.wheelEvent = _malloc(104);
  
      // The DOM Level 3 events spec event 'wheel'
      var wheelHandlerFunc = (e = event) => {
        var wheelEvent = targetThread ? _malloc(104) : JSEvents.wheelEvent; // This allocated block is passed as satellite data to the proxied function call, so the call frees up the data block when done.
        fillMouseEventData(wheelEvent, e, target);
        HEAPF64[(((wheelEvent)+(72))>>3)] = e["deltaX"];
        HEAPF64[(((wheelEvent)+(80))>>3)] = e["deltaY"];
        HEAPF64[(((wheelEvent)+(88))>>3)] = e["deltaZ"];
        HEAP32[(((wheelEvent)+(96))>>2)] = e["deltaMode"];
        if (targetThread) __emscripten_run_callback_on_thread(targetThread, callbackfunc, eventTypeId, wheelEvent, userData);
        else
        if (getWasmTableEntry(callbackfunc)(eventTypeId, wheelEvent, userData)) e.preventDefault();
      };
  
      var eventHandler = {
        target,
        allowsDeferredCalls: true,
        eventTypeString,
        callbackfunc,
        handlerFunc: wheelHandlerFunc,
        useCapture
      };
      return JSEvents.registerOrRemoveHandler(eventHandler);
    };
  
  
  
  function _emscripten_set_wheel_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(65, 0, 1, target, userData, useCapture, callbackfunc, targetThread);
  
      target = findEventTarget(target);
      if (!target) return -4;
      if (typeof target.onwheel != 'undefined') {
        return registerWheelEventCallback(target, userData, useCapture, callbackfunc, 9, "wheel", targetThread);
      } else {
        return -1;
      }
    
  }
  

  
  
  
  function _emscripten_set_window_title(title) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(66, 0, 1, title);
  return document.title = UTF8ToString(title)
  }
  

  var _emscripten_sleep = () => {
      throw 'Please compile your program with async support in order to use asynchronous operations like emscripten_sleep';
    };

  var _emscripten_unwind_to_js_event_loop = () => {
      throw 'unwind';
    };

  
  
  var _emscripten_supports_offscreencanvas = () =>
      // TODO: Add a new build mode, e.g. OFFSCREENCANVAS_SUPPORT=2, which
      // necessitates OffscreenCanvas support at build time, and "return 1;" here in that build mode.
      typeof OffscreenCanvas != 'undefined';
  
  
  var webglPowerPreferences = ["default","low-power","high-performance"];
  
  
  
  /** @suppress {duplicate } */
  var _emscripten_webgl_do_create_context = (target, attributes) => {
      var a = ((attributes)>>2);
      var powerPreference = HEAP32[a + (24>>2)];
      var contextAttributes = {
        'alpha': !!HEAP32[a + (0>>2)],
        'depth': !!HEAP32[a + (4>>2)],
        'stencil': !!HEAP32[a + (8>>2)],
        'antialias': !!HEAP32[a + (12>>2)],
        'premultipliedAlpha': !!HEAP32[a + (16>>2)],
        'preserveDrawingBuffer': !!HEAP32[a + (20>>2)],
        'powerPreference': webglPowerPreferences[powerPreference],
        'failIfMajorPerformanceCaveat': !!HEAP32[a + (28>>2)],
        // The following are not predefined WebGL context attributes in the WebGL specification, so the property names can be minified by Closure.
        majorVersion: HEAP32[a + (32>>2)],
        minorVersion: HEAP32[a + (36>>2)],
        enableExtensionsByDefault: HEAP32[a + (40>>2)],
        explicitSwapControl: HEAP32[a + (44>>2)],
        proxyContextToMainThread: HEAP32[a + (48>>2)],
        renderViaOffscreenBackBuffer: HEAP32[a + (52>>2)]
      };
  
      var canvas = findCanvasEventTarget(target);
  
      if (!canvas) {
        return 0;
      }
  
      if (canvas.offscreenCanvas) canvas = canvas.offscreenCanvas;
  
      if (contextAttributes.explicitSwapControl) {
        var supportsOffscreenCanvas = canvas.transferControlToOffscreen || (_emscripten_supports_offscreencanvas() && canvas instanceof OffscreenCanvas);
  
        if (!supportsOffscreenCanvas) {
          return 0;
        }
  
        if (canvas.transferControlToOffscreen) {
          if (!canvas.controlTransferredOffscreen) {
            GL.offscreenCanvases[canvas.id] = {
              canvas: canvas.transferControlToOffscreen(),
              canvasSharedPtr: _malloc(12),
              id: canvas.id
            };
            canvas.controlTransferredOffscreen = true;
          } else if (!GL.offscreenCanvases[canvas.id]) {
            return 0;
          }
          canvas = GL.offscreenCanvases[canvas.id];
        }
      }
  
      var contextHandle = GL.createContext(canvas, contextAttributes);
      return contextHandle;
    };
  var _emscripten_webgl_create_context = _emscripten_webgl_do_create_context;

  
  var _emscripten_webgl_destroy_context_calling_thread = (contextHandle) => {
      if (GL.currentContext == contextHandle) GL.currentContext = 0;
      GL.deleteContext(contextHandle);
    };
  
  
  var _emscripten_webgl_destroy_context_main_thread = _emscripten_webgl_destroy_context_calling_thread;
  
  function _emscripten_webgl_destroy_context(p0
  ) {
  return GL.contexts[p0] ? _emscripten_webgl_destroy_context_calling_thread(p0) : _emscripten_webgl_destroy_context_main_thread(p0);
  }

  var _emscripten_webgl_make_context_current = (contextHandle) => {
      var success = GL.makeContextCurrent(contextHandle);
      return success ? 0 : -5;
    };

  var ENV = {
  };
  
  var getExecutableName = () => {
      return thisProgram || './this.program';
    };
  var getEnvStrings = () => {
      if (!getEnvStrings.strings) {
        // Default values.
        // Browser language detection #8751
        var lang = ((typeof navigator == 'object' && navigator.languages && navigator.languages[0]) || 'C').replace('-', '_') + '.UTF-8';
        var env = {
          'USER': 'web_user',
          'LOGNAME': 'web_user',
          'PATH': '/',
          'PWD': '/',
          'HOME': '/home/web_user',
          'LANG': lang,
          '_': getExecutableName()
        };
        // Apply the user-provided values, if any.
        for (var x in ENV) {
          // x is a key in ENV; if ENV[x] is undefined, that means it was
          // explicitly set to be so. We allow user code to do that to
          // force variables with default values to remain unset.
          if (ENV[x] === undefined) delete env[x];
          else env[x] = ENV[x];
        }
        var strings = [];
        for (var x in env) {
          strings.push(`${x}=${env[x]}`);
        }
        getEnvStrings.strings = strings;
      }
      return getEnvStrings.strings;
    };
  
  var stringToAscii = (str, buffer) => {
      for (var i = 0; i < str.length; ++i) {
        HEAP8[buffer++] = str.charCodeAt(i);
      }
      // Null-terminate the string
      HEAP8[buffer] = 0;
    };
  
  var _environ_get = 
  function(__environ, environ_buf) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(67, 0, 1, __environ, environ_buf);
  
      var bufSize = 0;
      getEnvStrings().forEach((string, i) => {
        var ptr = environ_buf + bufSize;
        HEAPU32[(((__environ)+(i*4))>>2)] = ptr;
        stringToAscii(string, ptr);
        bufSize += string.length + 1;
      });
      return 0;
    
  }
  ;

  
  var _environ_sizes_get = 
  function(penviron_count, penviron_buf_size) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(68, 0, 1, penviron_count, penviron_buf_size);
  
      var strings = getEnvStrings();
      HEAPU32[((penviron_count)>>2)] = strings.length;
      var bufSize = 0;
      strings.forEach((string) => bufSize += string.length + 1);
      HEAPU32[((penviron_buf_size)>>2)] = bufSize;
      return 0;
    
  }
  ;


  
  
  function _fd_close(fd) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(69, 0, 1, fd);
  
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      FS.close(stream);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return e.errno;
  }
  
  }
  

  
  
  function _fd_fdstat_get(fd, pbuf) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(70, 0, 1, fd, pbuf);
  
  try {
  
      var rightsBase = 0;
      var rightsInheriting = 0;
      var flags = 0;
      {
        var stream = SYSCALLS.getStreamFromFD(fd);
        // All character devices are terminals (other things a Linux system would
        // assume is a character device, like the mouse, we have special APIs for).
        var type = stream.tty ? 2 :
                   FS.isDir(stream.mode) ? 3 :
                   FS.isLink(stream.mode) ? 7 :
                   4;
      }
      HEAP8[pbuf] = type;
      HEAP16[(((pbuf)+(2))>>1)] = flags;
      HEAP64[(((pbuf)+(8))>>3)] = BigInt(rightsBase);
      HEAP64[(((pbuf)+(16))>>3)] = BigInt(rightsInheriting);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return e.errno;
  }
  
  }
  

  /** @param {number=} offset */
  var doReadv = (stream, iov, iovcnt, offset) => {
      var ret = 0;
      for (var i = 0; i < iovcnt; i++) {
        var ptr = HEAPU32[((iov)>>2)];
        var len = HEAPU32[(((iov)+(4))>>2)];
        iov += 8;
        var curr = FS.read(stream, HEAP8, ptr, len, offset);
        if (curr < 0) return -1;
        ret += curr;
        if (curr < len) break; // nothing more to read
        if (typeof offset !== 'undefined') {
          offset += curr;
        }
      }
      return ret;
    };
  
  
  
  
  function _fd_pread(fd, iov, iovcnt, offset, pnum) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(71, 0, 1, fd, iov, iovcnt, offset, pnum);
  
    offset = bigintToI53Checked(offset);
  
    
  try {
  
      if (isNaN(offset)) return 61;
      var stream = SYSCALLS.getStreamFromFD(fd)
      var num = doReadv(stream, iov, iovcnt, offset);
      HEAPU32[((pnum)>>2)] = num;
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return e.errno;
  }
  ;
  
  }
  

  /** @param {number=} offset */
  var doWritev = (stream, iov, iovcnt, offset) => {
      var ret = 0;
      for (var i = 0; i < iovcnt; i++) {
        var ptr = HEAPU32[((iov)>>2)];
        var len = HEAPU32[(((iov)+(4))>>2)];
        iov += 8;
        var curr = FS.write(stream, HEAP8, ptr, len, offset);
        if (curr < 0) return -1;
        ret += curr;
        if (typeof offset !== 'undefined') {
          offset += curr;
        }
      }
      return ret;
    };
  
  
  
  
  function _fd_pwrite(fd, iov, iovcnt, offset, pnum) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(72, 0, 1, fd, iov, iovcnt, offset, pnum);
  
    offset = bigintToI53Checked(offset);
  
    
  try {
  
      if (isNaN(offset)) return 61;
      var stream = SYSCALLS.getStreamFromFD(fd)
      var num = doWritev(stream, iov, iovcnt, offset);
      HEAPU32[((pnum)>>2)] = num;
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return e.errno;
  }
  ;
  
  }
  

  
  
  
  function _fd_read(fd, iov, iovcnt, pnum) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(73, 0, 1, fd, iov, iovcnt, pnum);
  
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      var num = doReadv(stream, iov, iovcnt);
      HEAPU32[((pnum)>>2)] = num;
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return e.errno;
  }
  
  }
  

  
  
  
  function _fd_seek(fd, offset, whence, newOffset) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(74, 0, 1, fd, offset, whence, newOffset);
  
    offset = bigintToI53Checked(offset);
  
    
  try {
  
      if (isNaN(offset)) return 61;
      var stream = SYSCALLS.getStreamFromFD(fd);
      FS.llseek(stream, offset, whence);
      HEAP64[((newOffset)>>3)] = BigInt(stream.position);
      if (stream.getdents && offset === 0 && whence === 0) stream.getdents = null; // reset readdir state
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return e.errno;
  }
  ;
  
  }
  

  
  
  function _fd_sync(fd) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(75, 0, 1, fd);
  
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      if (stream.stream_ops?.fsync) {
        return stream.stream_ops.fsync(stream);
      }
      return 0; // we can't do anything synchronously; the in-memory FS is already synced to
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return e.errno;
  }
  
  }
  

  
  
  
  function _fd_write(fd, iov, iovcnt, pnum) {
  if (ENVIRONMENT_IS_PTHREAD)
    return proxyToMainThread(76, 0, 1, fd, iov, iovcnt, pnum);
  
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      var num = doWritev(stream, iov, iovcnt);
      HEAPU32[((pnum)>>2)] = num;
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return e.errno;
  }
  
  }
  

  var _getentropy = (buffer, size) => {
      randomFill(HEAPU8.subarray(buffer, buffer + size));
      return 0;
    };

  var DOTNET = {
  setup:function setup(emscriptenBuildOptions) {
      // USE_PTHREADS is emscripten's define symbol, which is passed to acorn optimizer, so we could use it here
      const modulePThread = PThread;
      const dotnet_replacements = {
          fetch: globalThis.fetch,
          ENVIRONMENT_IS_WORKER,
          require,
          modulePThread,
          scriptDirectory,
      };
  
      ENVIRONMENT_IS_WORKER = dotnet_replacements.ENVIRONMENT_IS_WORKER;
      Module.__dotnet_runtime.initializeReplacements(dotnet_replacements);
      noExitRuntime = dotnet_replacements.noExitRuntime;
      fetch = dotnet_replacements.fetch;
      require = dotnet_replacements.require;
      _scriptDir = __dirname = scriptDirectory = dotnet_replacements.scriptDirectory;
      Module.__dotnet_runtime.passEmscriptenInternals({
          isPThread: ENVIRONMENT_IS_PTHREAD,
          quit_, ExitStatus,
          updateMemoryViews,
          getMemory: () => { return wasmMemory; },
          getWasmIndirectFunctionTable: () => { return wasmTable; },
      }, emscriptenBuildOptions);
  
      if (ENVIRONMENT_IS_PTHREAD) {
          Module.config = {};
          Module.__dotnet_runtime.configureWorkerStartup(Module);
      } else {
          Module.__dotnet_runtime.configureEmscriptenStartup(Module);
      }
  },
  };
  function _mono_interp_tier_prepare_jiterpreter(
  ) {
  return {runtime_idx:7};//mono_interp_tier_prepare_jiterpreter
  }

  function _mono_wasm_browser_entropy(
  ) {
  return {runtime_idx:18};//mono_wasm_browser_entropy
  }

  function _mono_wasm_cancel_promise(
  ) {
  return {runtime_idx:26};//mono_wasm_cancel_promise
  }

  function _mono_wasm_console_clear(
  ) {
  return {runtime_idx:20};//mono_wasm_console_clear
  }

  function _mono_wasm_dump_threads(
  ) {
  return {runtime_idx:40};//mono_wasm_dump_threads
  }

  function _mono_wasm_free_method_data(
  ) {
  return {runtime_idx:13};//mono_wasm_free_method_data
  }

  function _mono_wasm_get_locale_info(
  ) {
  return {runtime_idx:27};//mono_wasm_get_locale_info
  }

  function _mono_wasm_install_js_worker_interop(
  ) {
  return {runtime_idx:41};//mono_wasm_install_js_worker_interop
  }

  function _mono_wasm_invoke_js_function(
  ) {
  return {runtime_idx:23};//mono_wasm_invoke_js_function
  }

  function _mono_wasm_invoke_jsimport_MT(
  ) {
  return {runtime_idx:43};//mono_wasm_invoke_jsimport_MT
  }

  function _mono_wasm_process_current_pid(
  ) {
  return {runtime_idx:19};//mono_wasm_process_current_pid
  }

  function _mono_wasm_pthread_on_pthread_attached(
  ) {
  return {runtime_idx:34};//mono_wasm_pthread_on_pthread_attached
  }

  function _mono_wasm_pthread_on_pthread_registered(
  ) {
  return {runtime_idx:33};//mono_wasm_pthread_on_pthread_registered
  }

  function _mono_wasm_pthread_on_pthread_unregistered(
  ) {
  return {runtime_idx:35};//mono_wasm_pthread_on_pthread_unregistered
  }

  function _mono_wasm_pthread_set_name(
  ) {
  return {runtime_idx:36};//mono_wasm_pthread_set_name
  }

  function _mono_wasm_release_cs_owned_object(
  ) {
  return {runtime_idx:21};//mono_wasm_release_cs_owned_object
  }

  function _mono_wasm_resolve_or_reject_promise(
  ) {
  return {runtime_idx:25};//mono_wasm_resolve_or_reject_promise
  }

  function _mono_wasm_schedule_synchronization_context(
  ) {
  return {runtime_idx:39};//mono_wasm_schedule_synchronization_context
  }

  function _mono_wasm_set_entrypoint_breakpoint(
  ) {
  return {runtime_idx:17};//mono_wasm_set_entrypoint_breakpoint
  }

  function _mono_wasm_start_deputy_thread_async(
  ) {
  return {runtime_idx:37};//mono_wasm_start_deputy_thread_async
  }

  function _mono_wasm_start_io_thread_async(
  ) {
  return {runtime_idx:38};//mono_wasm_start_io_thread_async
  }

  function _mono_wasm_trace_logger(
  ) {
  return {runtime_idx:16};//mono_wasm_trace_logger
  }

  function _mono_wasm_uninstall_js_worker_interop(
  ) {
  return {runtime_idx:42};//mono_wasm_uninstall_js_worker_interop
  }

  function _mono_wasm_warn_about_blocking_wait(
  ) {
  return {runtime_idx:44};//mono_wasm_warn_about_blocking_wait
  }


  
  var arraySum = (array, index) => {
      var sum = 0;
      for (var i = 0; i <= index; sum += array[i++]) {
        // no-op
      }
      return sum;
    };
  
  
  var MONTH_DAYS_LEAP = [31,29,31,30,31,30,31,31,30,31,30,31];
  
  var MONTH_DAYS_REGULAR = [31,28,31,30,31,30,31,31,30,31,30,31];
  var addDays = (date, days) => {
      var newDate = new Date(date.getTime());
      while (days > 0) {
        var leap = isLeapYear(newDate.getFullYear());
        var currentMonth = newDate.getMonth();
        var daysInCurrentMonth = (leap ? MONTH_DAYS_LEAP : MONTH_DAYS_REGULAR)[currentMonth];
  
        if (days > daysInCurrentMonth-newDate.getDate()) {
          // we spill over to next month
          days -= (daysInCurrentMonth-newDate.getDate()+1);
          newDate.setDate(1);
          if (currentMonth < 11) {
            newDate.setMonth(currentMonth+1)
          } else {
            newDate.setMonth(0);
            newDate.setFullYear(newDate.getFullYear()+1);
          }
        } else {
          // we stay in current month
          newDate.setDate(newDate.getDate()+days);
          return newDate;
        }
      }
  
      return newDate;
    };
  
  
  
  
  var writeArrayToMemory = (array, buffer) => {
      HEAP8.set(array, buffer);
    };
  
  var _strftime = (s, maxsize, format, tm) => {
      // size_t strftime(char *restrict s, size_t maxsize, const char *restrict format, const struct tm *restrict timeptr);
      // http://pubs.opengroup.org/onlinepubs/009695399/functions/strftime.html
  
      var tm_zone = HEAPU32[(((tm)+(40))>>2)];
  
      var date = {
        tm_sec: HEAP32[((tm)>>2)],
        tm_min: HEAP32[(((tm)+(4))>>2)],
        tm_hour: HEAP32[(((tm)+(8))>>2)],
        tm_mday: HEAP32[(((tm)+(12))>>2)],
        tm_mon: HEAP32[(((tm)+(16))>>2)],
        tm_year: HEAP32[(((tm)+(20))>>2)],
        tm_wday: HEAP32[(((tm)+(24))>>2)],
        tm_yday: HEAP32[(((tm)+(28))>>2)],
        tm_isdst: HEAP32[(((tm)+(32))>>2)],
        tm_gmtoff: HEAP32[(((tm)+(36))>>2)],
        tm_zone: tm_zone ? UTF8ToString(tm_zone) : ''
      };
      
  
      var pattern = UTF8ToString(format);
  
      // expand format
      var EXPANSION_RULES_1 = {
        '%c': '%a %b %d %H:%M:%S %Y',     // Replaced by the locale's appropriate date and time representation - e.g., Mon Aug  3 14:02:01 2013
        '%D': '%m/%d/%y',                 // Equivalent to %m / %d / %y
        '%F': '%Y-%m-%d',                 // Equivalent to %Y - %m - %d
        '%h': '%b',                       // Equivalent to %b
        '%r': '%I:%M:%S %p',              // Replaced by the time in a.m. and p.m. notation
        '%R': '%H:%M',                    // Replaced by the time in 24-hour notation
        '%T': '%H:%M:%S',                 // Replaced by the time
        '%x': '%m/%d/%y',                 // Replaced by the locale's appropriate date representation
        '%X': '%H:%M:%S',                 // Replaced by the locale's appropriate time representation
        // Modified Conversion Specifiers
        '%Ec': '%c',                      // Replaced by the locale's alternative appropriate date and time representation.
        '%EC': '%C',                      // Replaced by the name of the base year (period) in the locale's alternative representation.
        '%Ex': '%m/%d/%y',                // Replaced by the locale's alternative date representation.
        '%EX': '%H:%M:%S',                // Replaced by the locale's alternative time representation.
        '%Ey': '%y',                      // Replaced by the offset from %EC (year only) in the locale's alternative representation.
        '%EY': '%Y',                      // Replaced by the full alternative year representation.
        '%Od': '%d',                      // Replaced by the day of the month, using the locale's alternative numeric symbols, filled as needed with leading zeros if there is any alternative symbol for zero; otherwise, with leading <space> characters.
        '%Oe': '%e',                      // Replaced by the day of the month, using the locale's alternative numeric symbols, filled as needed with leading <space> characters.
        '%OH': '%H',                      // Replaced by the hour (24-hour clock) using the locale's alternative numeric symbols.
        '%OI': '%I',                      // Replaced by the hour (12-hour clock) using the locale's alternative numeric symbols.
        '%Om': '%m',                      // Replaced by the month using the locale's alternative numeric symbols.
        '%OM': '%M',                      // Replaced by the minutes using the locale's alternative numeric symbols.
        '%OS': '%S',                      // Replaced by the seconds using the locale's alternative numeric symbols.
        '%Ou': '%u',                      // Replaced by the weekday as a number in the locale's alternative representation (Monday=1).
        '%OU': '%U',                      // Replaced by the week number of the year (Sunday as the first day of the week, rules corresponding to %U ) using the locale's alternative numeric symbols.
        '%OV': '%V',                      // Replaced by the week number of the year (Monday as the first day of the week, rules corresponding to %V ) using the locale's alternative numeric symbols.
        '%Ow': '%w',                      // Replaced by the number of the weekday (Sunday=0) using the locale's alternative numeric symbols.
        '%OW': '%W',                      // Replaced by the week number of the year (Monday as the first day of the week) using the locale's alternative numeric symbols.
        '%Oy': '%y',                      // Replaced by the year (offset from %C ) using the locale's alternative numeric symbols.
      };
      for (var rule in EXPANSION_RULES_1) {
        pattern = pattern.replace(new RegExp(rule, 'g'), EXPANSION_RULES_1[rule]);
      }
  
      var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  
      function leadingSomething(value, digits, character) {
        var str = typeof value == 'number' ? value.toString() : (value || '');
        while (str.length < digits) {
          str = character[0]+str;
        }
        return str;
      }
  
      function leadingNulls(value, digits) {
        return leadingSomething(value, digits, '0');
      }
  
      function compareByDay(date1, date2) {
        function sgn(value) {
          return value < 0 ? -1 : (value > 0 ? 1 : 0);
        }
  
        var compare;
        if ((compare = sgn(date1.getFullYear()-date2.getFullYear())) === 0) {
          if ((compare = sgn(date1.getMonth()-date2.getMonth())) === 0) {
            compare = sgn(date1.getDate()-date2.getDate());
          }
        }
        return compare;
      }
  
      function getFirstWeekStartDate(janFourth) {
          switch (janFourth.getDay()) {
            case 0: // Sunday
              return new Date(janFourth.getFullYear()-1, 11, 29);
            case 1: // Monday
              return janFourth;
            case 2: // Tuesday
              return new Date(janFourth.getFullYear(), 0, 3);
            case 3: // Wednesday
              return new Date(janFourth.getFullYear(), 0, 2);
            case 4: // Thursday
              return new Date(janFourth.getFullYear(), 0, 1);
            case 5: // Friday
              return new Date(janFourth.getFullYear()-1, 11, 31);
            case 6: // Saturday
              return new Date(janFourth.getFullYear()-1, 11, 30);
          }
      }
  
      function getWeekBasedYear(date) {
          var thisDate = addDays(new Date(date.tm_year+1900, 0, 1), date.tm_yday);
  
          var janFourthThisYear = new Date(thisDate.getFullYear(), 0, 4);
          var janFourthNextYear = new Date(thisDate.getFullYear()+1, 0, 4);
  
          var firstWeekStartThisYear = getFirstWeekStartDate(janFourthThisYear);
          var firstWeekStartNextYear = getFirstWeekStartDate(janFourthNextYear);
  
          if (compareByDay(firstWeekStartThisYear, thisDate) <= 0) {
            // this date is after the start of the first week of this year
            if (compareByDay(firstWeekStartNextYear, thisDate) <= 0) {
              return thisDate.getFullYear()+1;
            }
            return thisDate.getFullYear();
          }
          return thisDate.getFullYear()-1;
      }
  
      var EXPANSION_RULES_2 = {
        '%a': (date) => WEEKDAYS[date.tm_wday].substring(0,3) ,
        '%A': (date) => WEEKDAYS[date.tm_wday],
        '%b': (date) => MONTHS[date.tm_mon].substring(0,3),
        '%B': (date) => MONTHS[date.tm_mon],
        '%C': (date) => {
          var year = date.tm_year+1900;
          return leadingNulls((year/100)|0,2);
        },
        '%d': (date) => leadingNulls(date.tm_mday, 2),
        '%e': (date) => leadingSomething(date.tm_mday, 2, ' '),
        '%g': (date) => {
          // %g, %G, and %V give values according to the ISO 8601:2000 standard week-based year.
          // In this system, weeks begin on a Monday and week 1 of the year is the week that includes
          // January 4th, which is also the week that includes the first Thursday of the year, and
          // is also the first week that contains at least four days in the year.
          // If the first Monday of January is the 2nd, 3rd, or 4th, the preceding days are part of
          // the last week of the preceding year; thus, for Saturday 2nd January 1999,
          // %G is replaced by 1998 and %V is replaced by 53. If December 29th, 30th,
          // or 31st is a Monday, it and any following days are part of week 1 of the following year.
          // Thus, for Tuesday 30th December 1997, %G is replaced by 1998 and %V is replaced by 01.
  
          return getWeekBasedYear(date).toString().substring(2);
        },
        '%G': getWeekBasedYear,
        '%H': (date) => leadingNulls(date.tm_hour, 2),
        '%I': (date) => {
          var twelveHour = date.tm_hour;
          if (twelveHour == 0) twelveHour = 12;
          else if (twelveHour > 12) twelveHour -= 12;
          return leadingNulls(twelveHour, 2);
        },
        '%j': (date) => {
          // Day of the year (001-366)
          return leadingNulls(date.tm_mday + arraySum(isLeapYear(date.tm_year+1900) ? MONTH_DAYS_LEAP : MONTH_DAYS_REGULAR, date.tm_mon-1), 3);
        },
        '%m': (date) => leadingNulls(date.tm_mon+1, 2),
        '%M': (date) => leadingNulls(date.tm_min, 2),
        '%n': () => '\n',
        '%p': (date) => {
          if (date.tm_hour >= 0 && date.tm_hour < 12) {
            return 'AM';
          }
          return 'PM';
        },
        '%S': (date) => leadingNulls(date.tm_sec, 2),
        '%t': () => '\t',
        '%u': (date) => date.tm_wday || 7,
        '%U': (date) => {
          var days = date.tm_yday + 7 - date.tm_wday;
          return leadingNulls(Math.floor(days / 7), 2);
        },
        '%V': (date) => {
          // Replaced by the week number of the year (Monday as the first day of the week)
          // as a decimal number [01,53]. If the week containing 1 January has four
          // or more days in the new year, then it is considered week 1.
          // Otherwise, it is the last week of the previous year, and the next week is week 1.
          // Both January 4th and the first Thursday of January are always in week 1. [ tm_year, tm_wday, tm_yday]
          var val = Math.floor((date.tm_yday + 7 - (date.tm_wday + 6) % 7 ) / 7);
          // If 1 Jan is just 1-3 days past Monday, the previous week
          // is also in this year.
          if ((date.tm_wday + 371 - date.tm_yday - 2) % 7 <= 2) {
            val++;
          }
          if (!val) {
            val = 52;
            // If 31 December of prev year a Thursday, or Friday of a
            // leap year, then the prev year has 53 weeks.
            var dec31 = (date.tm_wday + 7 - date.tm_yday - 1) % 7;
            if (dec31 == 4 || (dec31 == 5 && isLeapYear(date.tm_year%400-1))) {
              val++;
            }
          } else if (val == 53) {
            // If 1 January is not a Thursday, and not a Wednesday of a
            // leap year, then this year has only 52 weeks.
            var jan1 = (date.tm_wday + 371 - date.tm_yday) % 7;
            if (jan1 != 4 && (jan1 != 3 || !isLeapYear(date.tm_year)))
              val = 1;
          }
          return leadingNulls(val, 2);
        },
        '%w': (date) => date.tm_wday,
        '%W': (date) => {
          var days = date.tm_yday + 7 - ((date.tm_wday + 6) % 7);
          return leadingNulls(Math.floor(days / 7), 2);
        },
        '%y': (date) => {
          // Replaced by the last two digits of the year as a decimal number [00,99]. [ tm_year]
          return (date.tm_year+1900).toString().substring(2);
        },
        // Replaced by the year as a decimal number (for example, 1997). [ tm_year]
        '%Y': (date) => date.tm_year+1900,
        '%z': (date) => {
          // Replaced by the offset from UTC in the ISO 8601:2000 standard format ( +hhmm or -hhmm ).
          // For example, "-0430" means 4 hours 30 minutes behind UTC (west of Greenwich).
          var off = date.tm_gmtoff;
          var ahead = off >= 0;
          off = Math.abs(off) / 60;
          // convert from minutes into hhmm format (which means 60 minutes = 100 units)
          off = (off / 60)*100 + (off % 60);
          return (ahead ? '+' : '-') + String("0000" + off).slice(-4);
        },
        '%Z': (date) => date.tm_zone,
        '%%': () => '%'
      };
  
      // Replace %% with a pair of NULLs (which cannot occur in a C string), then
      // re-inject them after processing.
      pattern = pattern.replace(/%%/g, '\0\0')
      for (var rule in EXPANSION_RULES_2) {
        if (pattern.includes(rule)) {
          pattern = pattern.replace(new RegExp(rule, 'g'), EXPANSION_RULES_2[rule](date));
        }
      }
      pattern = pattern.replace(/\0\0/g, '%')
  
      var bytes = intArrayFromString(pattern, false);
      if (bytes.length > maxsize) {
        return 0;
      }
  
      writeArrayToMemory(bytes, s);
      return bytes.length-1;
    };

  var dynCall = (sig, ptr, args = []) => {
      var rtn = getWasmTableEntry(ptr)(...args);
      return rtn;
    };



  var listenOnce = (object, event, func) => {
      object.addEventListener(event, func, { 'once': true });
    };
  /** @param {Object=} elements */
  var autoResumeAudioContext = (ctx, elements) => {
      if (!elements) {
        elements = [document, document.getElementById('canvas')];
      }
      ['keydown', 'mousedown', 'touchstart'].forEach((event) => {
        elements.forEach((element) => {
          if (element) {
            listenOnce(element, event, () => {
              if (ctx.state === 'suspended') ctx.resume();
            });
          }
        });
      });
    };







  var getCFunc = (ident) => {
      var func = Module['_' + ident]; // closure exported function
      return func;
    };
  
  
  
  
  
  
  
    /**
     * @param {string|null=} returnType
     * @param {Array=} argTypes
     * @param {Arguments|Array=} args
     * @param {Object=} opts
     */
  var ccall = (ident, returnType, argTypes, args, opts) => {
      // For fast lookup of conversion functions
      var toC = {
        'string': (str) => {
          var ret = 0;
          if (str !== null && str !== undefined && str !== 0) { // null string
            // at most 4 bytes per UTF-8 code point, +1 for the trailing '\0'
            ret = stringToUTF8OnStack(str);
          }
          return ret;
        },
        'array': (arr) => {
          var ret = stackAlloc(arr.length);
          writeArrayToMemory(arr, ret);
          return ret;
        }
      };
  
      function convertReturnValue(ret) {
        if (returnType === 'string') {
          
          return UTF8ToString(ret);
        }
        if (returnType === 'boolean') return Boolean(ret);
        return ret;
      }
  
      var func = getCFunc(ident);
      var cArgs = [];
      var stack = 0;
      if (args) {
        for (var i = 0; i < args.length; i++) {
          var converter = toC[argTypes[i]];
          if (converter) {
            if (stack === 0) stack = stackSave();
            cArgs[i] = converter(args[i]);
          } else {
            cArgs[i] = args[i];
          }
        }
      }
      var ret = func(...cArgs);
      function onDone(ret) {
        if (stack !== 0) stackRestore(stack);
        return convertReturnValue(ret);
      }
  
      ret = onDone(ret);
      return ret;
    };

  
  
    /**
     * @param {string=} returnType
     * @param {Array=} argTypes
     * @param {Object=} opts
     */
  var cwrap = (ident, returnType, argTypes, opts) => {
      // When the function takes numbers and returns a number, we can just return
      // the original function
      var numericArgs = !argTypes || argTypes.every((type) => type === 'number' || type === 'boolean');
      var numericRet = returnType !== 'string';
      if (numericRet && numericArgs && !opts) {
        return getCFunc(ident);
      }
      return (...args) => ccall(ident, returnType, argTypes, args, opts);
    };








  var uleb128Encode = (n, target) => {
      if (n < 128) {
        target.push(n);
      } else {
        target.push((n % 128) | 128, n >> 7);
      }
    };
  
  var sigToWasmTypes = (sig) => {
      var typeNames = {
        'i': 'i32',
        'j': 'i64',
        'f': 'f32',
        'd': 'f64',
        'e': 'externref',
        'p': 'i32',
      };
      var type = {
        parameters: [],
        results: sig[0] == 'v' ? [] : [typeNames[sig[0]]]
      };
      for (var i = 1; i < sig.length; ++i) {
        type.parameters.push(typeNames[sig[i]]);
      }
      return type;
    };
  
  var generateFuncType = (sig, target) => {
      var sigRet = sig.slice(0, 1);
      var sigParam = sig.slice(1);
      var typeCodes = {
        'i': 0x7f, // i32
        'p': 0x7f, // i32
        'j': 0x7e, // i64
        'f': 0x7d, // f32
        'd': 0x7c, // f64
        'e': 0x6f, // externref
      };
  
      // Parameters, length + signatures
      target.push(0x60 /* form: func */);
      uleb128Encode(sigParam.length, target);
      for (var i = 0; i < sigParam.length; ++i) {
        target.push(typeCodes[sigParam[i]]);
      }
  
      // Return values, length + signatures
      // With no multi-return in MVP, either 0 (void) or 1 (anything else)
      if (sigRet == 'v') {
        target.push(0x00);
      } else {
        target.push(0x01, typeCodes[sigRet]);
      }
    };
  var convertJsFunctionToWasm = (func, sig) => {
  
      // If the type reflection proposal is available, use the new
      // "WebAssembly.Function" constructor.
      // Otherwise, construct a minimal wasm module importing the JS function and
      // re-exporting it.
      if (typeof WebAssembly.Function == "function") {
        return new WebAssembly.Function(sigToWasmTypes(sig), func);
      }
  
      // The module is static, with the exception of the type section, which is
      // generated based on the signature passed in.
      var typeSectionBody = [
        0x01, // count: 1
      ];
      generateFuncType(sig, typeSectionBody);
  
      // Rest of the module is static
      var bytes = [
        0x00, 0x61, 0x73, 0x6d, // magic ("\0asm")
        0x01, 0x00, 0x00, 0x00, // version: 1
        0x01, // Type section code
      ];
      // Write the overall length of the type section followed by the body
      uleb128Encode(typeSectionBody.length, bytes);
      bytes.push(...typeSectionBody);
  
      // The rest of the module is static
      bytes.push(
        0x02, 0x07, // import section
          // (import "e" "f" (func 0 (type 0)))
          0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00,
        0x07, 0x05, // export section
          // (export "f" (func 0 (type 0)))
          0x01, 0x01, 0x66, 0x00, 0x00,
      );
  
      // We can compile this wasm module synchronously because it is very small.
      // This accepts an import (at "e.f"), that it reroutes to an export (at "f")
      var module = new WebAssembly.Module(new Uint8Array(bytes));
      var instance = new WebAssembly.Instance(module, { 'e': { 'f': func } });
      var wrappedFunc = instance.exports['f'];
      return wrappedFunc;
    };
  
  
  var updateTableMap = (offset, count) => {
      if (functionsInTableMap) {
        for (var i = offset; i < offset + count; i++) {
          var item = getWasmTableEntry(i);
          // Ignore null values.
          if (item) {
            functionsInTableMap.set(item, i);
          }
        }
      }
    };
  
  var functionsInTableMap;
  
  var getFunctionAddress = (func) => {
      // First, create the map if this is the first use.
      if (!functionsInTableMap) {
        functionsInTableMap = new WeakMap();
        updateTableMap(0, wasmTable.length);
      }
      return functionsInTableMap.get(func) || 0;
    };
  
  
  var freeTableIndexes = [];
  
  var getEmptyTableSlot = () => {
      // Reuse a free index if there is one, otherwise grow.
      if (freeTableIndexes.length) {
        return freeTableIndexes.pop();
      }
      // Grow the table
      try {
        wasmTable.grow(1);
      } catch (err) {
        if (!(err instanceof RangeError)) {
          throw err;
        }
        throw 'Unable to grow wasm table. Set ALLOW_TABLE_GROWTH.';
      }
      return wasmTable.length - 1;
    };
  
  
  
  var setWasmTableEntry = (idx, func) => {
      wasmTable.set(idx, func);
      // With ABORT_ON_WASM_EXCEPTIONS wasmTable.get is overridden to return wrapped
      // functions so we need to call it here to retrieve the potential wrapper correctly
      // instead of just storing 'func' directly into wasmTableMirror
      wasmTableMirror[idx] = wasmTable.get(idx);
    };
  
  /** @param {string=} sig */
  var addFunction = (func, sig) => {
      // Check if the function is already in the table, to ensure each function
      // gets a unique index.
      var rtn = getFunctionAddress(func);
      if (rtn) {
        return rtn;
      }
  
      // It's not in the table, add it now.
  
      var ret = getEmptyTableSlot();
  
      // Set the new value.
      try {
        // Attempting to call this with JS function will cause of table.set() to fail
        setWasmTableEntry(ret, func);
      } catch (err) {
        if (!(err instanceof TypeError)) {
          throw err;
        }
        var wrapped = convertJsFunctionToWasm(func, sig);
        setWasmTableEntry(ret, wrapped);
      }
  
      functionsInTableMap.set(func, ret);
  
      return ret;
    };











  var FS_unlink = (path) => FS.unlink(path);
PThread.init();;

  FS.createPreloadedFile = FS_createPreloadedFile;
  FS.staticInit();Module["FS_createPath"] = FS.createPath;Module["FS_createDataFile"] = FS.createDataFile;Module["FS_createPath"] = FS.createPath;Module["FS_createDataFile"] = FS.createDataFile;Module["FS_createPreloadedFile"] = FS.createPreloadedFile;Module["FS_unlink"] = FS.unlink;Module["FS_createLazyFile"] = FS.createLazyFile;Module["FS_createDevice"] = FS.createDevice;;
var GLctx;;

      // exports
      Module["requestFullscreen"] = Browser.requestFullscreen;
      Module["requestAnimationFrame"] = Browser.requestAnimationFrame;
      Module["setCanvasSize"] = Browser.setCanvasSize;
      Module["pauseMainLoop"] = Browser.mainLoop.pause;
      Module["resumeMainLoop"] = Browser.mainLoop.resume;
      Module["getUserMedia"] = Browser.getUserMedia;
      Module["createContext"] = Browser.createContext;
      var preloadedImages = {};
      var preloadedAudios = {};;
for (var i = 0; i < 32; ++i) tempFixedLengthArray.push(new Array(i));;
DOTNET.setup({ wasmEnableSIMD: true,wasmEnableEH: true,enableAotProfiler: false, enableDevToolsProfiler: false, enableLogProfiler: false, enableEventPipe: false, runAOTCompilation: true, wasmEnableThreads: true, gitHash: "94ea82652cdd4e0f8046b5bd5becbd11461482ca", });;

// proxiedFunctionTable specifies the list of functions that can be called
// either synchronously or asynchronously from other threads in postMessage()d
// or internally queued events. This way a pthread in a Worker can synchronously
// access e.g. the DOM on the main thread.
var proxiedFunctionTable = [
  _proc_exit,
  exitOnMainThread,
  pthreadCreateProxied,
  ___syscall_chdir,
  ___syscall_chmod,
  ___syscall_connect,
  ___syscall_faccessat,
  ___syscall_fadvise64,
  ___syscall_fchmod,
  ___syscall_fcntl64,
  ___syscall_fdatasync,
  ___syscall_fstat64,
  ___syscall_fstatfs64,
  ___syscall_statfs64,
  ___syscall_ftruncate64,
  ___syscall_getcwd,
  ___syscall_getdents64,
  ___syscall_ioctl,
  ___syscall_lstat64,
  ___syscall_mkdirat,
  ___syscall_newfstatat,
  ___syscall_openat,
  ___syscall_readlinkat,
  ___syscall_renameat,
  ___syscall_rmdir,
  ___syscall_sendto,
  ___syscall_socket,
  ___syscall_stat64,
  ___syscall_symlink,
  ___syscall_unlinkat,
  ___syscall_utimensat,
  __emscripten_runtime_keepalive_clear,
  setCanvasElementSizeMainThread,
  __mmap_js,
  __msync_js,
  __munmap_js,
  _emscripten_exit_fullscreen,
  getCanvasSizeMainThread,
  _emscripten_exit_pointerlock,
  _emscripten_force_exit,
  _emscripten_get_battery_status,
  _emscripten_get_device_pixel_ratio,
  _emscripten_get_element_css_size,
  _emscripten_get_fullscreen_status,
  _emscripten_get_gamepad_status,
  _emscripten_get_num_gamepads,
  _emscripten_get_screen_size,
  _emscripten_request_fullscreen_strategy,
  _emscripten_request_pointerlock,
  _emscripten_sample_gamepad_data,
  _emscripten_set_beforeunload_callback_on_thread,
  _emscripten_set_blur_callback_on_thread,
  _emscripten_set_devicemotion_callback_on_thread,
  _emscripten_set_element_css_size,
  _emscripten_set_focus_callback_on_thread,
  _emscripten_set_fullscreenchange_callback_on_thread,
  _emscripten_set_gamepadconnected_callback_on_thread,
  _emscripten_set_gamepaddisconnected_callback_on_thread,
  _emscripten_set_keydown_callback_on_thread,
  _emscripten_set_keypress_callback_on_thread,
  _emscripten_set_keyup_callback_on_thread,
  _emscripten_set_orientationchange_callback_on_thread,
  _emscripten_set_pointerlockchange_callback_on_thread,
  _emscripten_set_resize_callback_on_thread,
  _emscripten_set_visibilitychange_callback_on_thread,
  _emscripten_set_wheel_callback_on_thread,
  _emscripten_set_window_title,
  _environ_get,
  _environ_sizes_get,
  _fd_close,
  _fd_fdstat_get,
  _fd_pread,
  _fd_pwrite,
  _fd_read,
  _fd_seek,
  _fd_sync,
  _fd_write
];

var wasmImports = {
  /** @export */
  SDL3_renamed_SDL_GetEmscriptenJoystickProduct: SDL3_renamed_SDL_GetEmscriptenJoystickProduct,
  /** @export */
  SDL3_renamed_SDL_GetEmscriptenJoystickVendor: SDL3_renamed_SDL_GetEmscriptenJoystickVendor,
  /** @export */
  SDL3_renamed_SDL_IsEmscriptenJoystickXInput: SDL3_renamed_SDL_IsEmscriptenJoystickXInput,
  /** @export */
  SDL_AndroidBackButton: _SDL_AndroidBackButton,
  /** @export */
  SDL_AndroidGetActivity: _SDL_AndroidGetActivity,
  /** @export */
  SDL_AndroidGetExternalStoragePath: _SDL_AndroidGetExternalStoragePath,
  /** @export */
  SDL_AndroidGetExternalStorageState: _SDL_AndroidGetExternalStorageState,
  /** @export */
  SDL_AndroidGetInternalStoragePath: _SDL_AndroidGetInternalStoragePath,
  /** @export */
  SDL_AndroidGetJNIEnv: _SDL_AndroidGetJNIEnv,
  /** @export */
  SDL_AndroidRequestPermission: _SDL_AndroidRequestPermission,
  /** @export */
  SDL_AndroidShowToast: _SDL_AndroidShowToast,
  /** @export */
  SDL_CloseIO: _SDL_CloseIO,
  /** @export */
  SDL_CreateThreadRuntime: _SDL_CreateThreadRuntime,
  /** @export */
  SDL_DestroyAudioStream: _SDL_DestroyAudioStream,
  /** @export */
  SDL_GDKRunApp: _SDL_GDKRunApp,
  /** @export */
  SDL_GetAndroidSDKVersion: _SDL_GetAndroidSDKVersion,
  /** @export */
  SDL_GetAudioDeviceFormat: _SDL_GetAudioDeviceFormat,
  /** @export */
  SDL_GetAudioPlaybackDevices: _SDL_GetAudioPlaybackDevices,
  /** @export */
  SDL_GetAudioStreamDevice: _SDL_GetAudioStreamDevice,
  /** @export */
  SDL_GetIOProperties: _SDL_GetIOProperties,
  /** @export */
  SDL_GetPointerProperty: _SDL_GetPointerProperty,
  /** @export */
  SDL_IOFromFile: _SDL_IOFromFile,
  /** @export */
  SDL_IOFromMem: _SDL_IOFromMem,
  /** @export */
  SDL_IsAndroidTV: _SDL_IsAndroidTV,
  /** @export */
  SDL_IsChromebook: _SDL_IsChromebook,
  /** @export */
  SDL_IsDeXMode: _SDL_IsDeXMode,
  /** @export */
  SDL_OpenAudioDeviceStream: _SDL_OpenAudioDeviceStream,
  /** @export */
  SDL_PutAudioStreamData: _SDL_PutAudioStreamData,
  /** @export */
  SDL_ReadIO: _SDL_ReadIO,
  /** @export */
  SDL_RenderGetD3D11Device: _SDL_RenderGetD3D11Device,
  /** @export */
  SDL_RenderGetD3D9Device: _SDL_RenderGetD3D9Device,
  /** @export */
  SDL_ResumeAudioDevice: _SDL_ResumeAudioDevice,
  /** @export */
  SDL_SeekIO: _SDL_SeekIO,
  /** @export */
  SDL_SetCurrentThreadPriority: _SDL_SetCurrentThreadPriority,
  /** @export */
  SDL_SetWindowsMessageHook: _SDL_SetWindowsMessageHook,
  /** @export */
  SDL_UIKitRunApp: _SDL_UIKitRunApp,
  /** @export */
  SDL_WinRTGetDeviceFamily: _SDL_WinRTGetDeviceFamily,
  /** @export */
  SDL_WinRTRunApp: _SDL_WinRTRunApp,
  /** @export */
  SDL_iPhoneSetAnimationCallback: _SDL_iPhoneSetAnimationCallback,
  /** @export */
  SDL_iPhoneSetEventPump: _SDL_iPhoneSetEventPump,
  /** @export */
  __assert_fail: ___assert_fail,
  /** @export */
  __call_sighandler: ___call_sighandler,
  /** @export */
  __emscripten_init_main_thread_js: ___emscripten_init_main_thread_js,
  /** @export */
  __emscripten_thread_cleanup: ___emscripten_thread_cleanup,
  /** @export */
  __pthread_create_js: ___pthread_create_js,
  /** @export */
  __syscall_chdir: ___syscall_chdir,
  /** @export */
  __syscall_chmod: ___syscall_chmod,
  /** @export */
  __syscall_connect: ___syscall_connect,
  /** @export */
  __syscall_faccessat: ___syscall_faccessat,
  /** @export */
  __syscall_fadvise64: ___syscall_fadvise64,
  /** @export */
  __syscall_fchmod: ___syscall_fchmod,
  /** @export */
  __syscall_fcntl64: ___syscall_fcntl64,
  /** @export */
  __syscall_fdatasync: ___syscall_fdatasync,
  /** @export */
  __syscall_fstat64: ___syscall_fstat64,
  /** @export */
  __syscall_fstatfs64: ___syscall_fstatfs64,
  /** @export */
  __syscall_ftruncate64: ___syscall_ftruncate64,
  /** @export */
  __syscall_getcwd: ___syscall_getcwd,
  /** @export */
  __syscall_getdents64: ___syscall_getdents64,
  /** @export */
  __syscall_ioctl: ___syscall_ioctl,
  /** @export */
  __syscall_lstat64: ___syscall_lstat64,
  /** @export */
  __syscall_mkdirat: ___syscall_mkdirat,
  /** @export */
  __syscall_newfstatat: ___syscall_newfstatat,
  /** @export */
  __syscall_openat: ___syscall_openat,
  /** @export */
  __syscall_readlinkat: ___syscall_readlinkat,
  /** @export */
  __syscall_renameat: ___syscall_renameat,
  /** @export */
  __syscall_rmdir: ___syscall_rmdir,
  /** @export */
  __syscall_sendto: ___syscall_sendto,
  /** @export */
  __syscall_socket: ___syscall_socket,
  /** @export */
  __syscall_stat64: ___syscall_stat64,
  /** @export */
  __syscall_symlink: ___syscall_symlink,
  /** @export */
  __syscall_unlinkat: ___syscall_unlinkat,
  /** @export */
  __syscall_utimensat: ___syscall_utimensat,
  /** @export */
  _emscripten_get_now_is_monotonic: __emscripten_get_now_is_monotonic,
  /** @export */
  _emscripten_notify_mailbox_postmessage: __emscripten_notify_mailbox_postmessage,
  /** @export */
  _emscripten_receive_on_main_thread_js: __emscripten_receive_on_main_thread_js,
  /** @export */
  _emscripten_runtime_keepalive_clear: __emscripten_runtime_keepalive_clear,
  /** @export */
  _emscripten_set_offscreencanvas_size: __emscripten_set_offscreencanvas_size,
  /** @export */
  _emscripten_thread_mailbox_await: __emscripten_thread_mailbox_await,
  /** @export */
  _emscripten_thread_set_strongref: __emscripten_thread_set_strongref,
  /** @export */
  _gmtime_js: __gmtime_js,
  /** @export */
  _localtime_js: __localtime_js,
  /** @export */
  _mmap_js: __mmap_js,
  /** @export */
  _msync_js: __msync_js,
  /** @export */
  _munmap_js: __munmap_js,
  /** @export */
  _tzset_js: __tzset_js,
  /** @export */
  abort: _abort,
  /** @export */
  emscripten_asm_const_async_on_main_thread: _emscripten_asm_const_async_on_main_thread,
  /** @export */
  emscripten_asm_const_double_sync_on_main_thread: _emscripten_asm_const_double_sync_on_main_thread,
  /** @export */
  emscripten_asm_const_int: _emscripten_asm_const_int,
  /** @export */
  emscripten_asm_const_int_sync_on_main_thread: _emscripten_asm_const_int_sync_on_main_thread,
  /** @export */
  emscripten_asm_const_ptr_sync_on_main_thread: _emscripten_asm_const_ptr_sync_on_main_thread,
  /** @export */
  emscripten_cancel_main_loop: _emscripten_cancel_main_loop,
  /** @export */
  emscripten_check_blocking_allowed: _emscripten_check_blocking_allowed,
  /** @export */
  emscripten_clear_timeout: _emscripten_clear_timeout,
  /** @export */
  emscripten_console_error: _emscripten_console_error,
  /** @export */
  emscripten_date_now: _emscripten_date_now,
  /** @export */
  emscripten_exit_fullscreen: _emscripten_exit_fullscreen,
  /** @export */
  emscripten_exit_pointerlock: _emscripten_exit_pointerlock,
  /** @export */
  emscripten_exit_with_live_runtime: _emscripten_exit_with_live_runtime,
  /** @export */
  emscripten_force_exit: _emscripten_force_exit,
  /** @export */
  emscripten_get_battery_status: _emscripten_get_battery_status,
  /** @export */
  emscripten_get_device_pixel_ratio: _emscripten_get_device_pixel_ratio,
  /** @export */
  emscripten_get_element_css_size: _emscripten_get_element_css_size,
  /** @export */
  emscripten_get_fullscreen_status: _emscripten_get_fullscreen_status,
  /** @export */
  emscripten_get_gamepad_status: _emscripten_get_gamepad_status,
  /** @export */
  emscripten_get_heap_max: _emscripten_get_heap_max,
  /** @export */
  emscripten_get_main_loop_timing: _emscripten_get_main_loop_timing,
  /** @export */
  emscripten_get_now: _emscripten_get_now,
  /** @export */
  emscripten_get_now_res: _emscripten_get_now_res,
  /** @export */
  emscripten_get_num_gamepads: _emscripten_get_num_gamepads,
  /** @export */
  emscripten_get_screen_size: _emscripten_get_screen_size,
  /** @export */
  emscripten_glActiveTexture: _emscripten_glActiveTexture,
  /** @export */
  emscripten_glAttachShader: _emscripten_glAttachShader,
  /** @export */
  emscripten_glBeginQuery: _emscripten_glBeginQuery,
  /** @export */
  emscripten_glBeginQueryEXT: _emscripten_glBeginQueryEXT,
  /** @export */
  emscripten_glBeginTransformFeedback: _emscripten_glBeginTransformFeedback,
  /** @export */
  emscripten_glBindAttribLocation: _emscripten_glBindAttribLocation,
  /** @export */
  emscripten_glBindBuffer: _emscripten_glBindBuffer,
  /** @export */
  emscripten_glBindBufferBase: _emscripten_glBindBufferBase,
  /** @export */
  emscripten_glBindBufferRange: _emscripten_glBindBufferRange,
  /** @export */
  emscripten_glBindFramebuffer: _emscripten_glBindFramebuffer,
  /** @export */
  emscripten_glBindRenderbuffer: _emscripten_glBindRenderbuffer,
  /** @export */
  emscripten_glBindSampler: _emscripten_glBindSampler,
  /** @export */
  emscripten_glBindTexture: _emscripten_glBindTexture,
  /** @export */
  emscripten_glBindTransformFeedback: _emscripten_glBindTransformFeedback,
  /** @export */
  emscripten_glBindVertexArray: _emscripten_glBindVertexArray,
  /** @export */
  emscripten_glBindVertexArrayOES: _emscripten_glBindVertexArrayOES,
  /** @export */
  emscripten_glBlendColor: _emscripten_glBlendColor,
  /** @export */
  emscripten_glBlendEquation: _emscripten_glBlendEquation,
  /** @export */
  emscripten_glBlendEquationSeparate: _emscripten_glBlendEquationSeparate,
  /** @export */
  emscripten_glBlendFunc: _emscripten_glBlendFunc,
  /** @export */
  emscripten_glBlendFuncSeparate: _emscripten_glBlendFuncSeparate,
  /** @export */
  emscripten_glBlitFramebuffer: _emscripten_glBlitFramebuffer,
  /** @export */
  emscripten_glBufferData: _emscripten_glBufferData,
  /** @export */
  emscripten_glBufferSubData: _emscripten_glBufferSubData,
  /** @export */
  emscripten_glCheckFramebufferStatus: _emscripten_glCheckFramebufferStatus,
  /** @export */
  emscripten_glClear: _emscripten_glClear,
  /** @export */
  emscripten_glClearBufferfi: _emscripten_glClearBufferfi,
  /** @export */
  emscripten_glClearBufferfv: _emscripten_glClearBufferfv,
  /** @export */
  emscripten_glClearBufferiv: _emscripten_glClearBufferiv,
  /** @export */
  emscripten_glClearBufferuiv: _emscripten_glClearBufferuiv,
  /** @export */
  emscripten_glClearColor: _emscripten_glClearColor,
  /** @export */
  emscripten_glClearDepthf: _emscripten_glClearDepthf,
  /** @export */
  emscripten_glClearStencil: _emscripten_glClearStencil,
  /** @export */
  emscripten_glClientWaitSync: _emscripten_glClientWaitSync,
  /** @export */
  emscripten_glColorMask: _emscripten_glColorMask,
  /** @export */
  emscripten_glCompileShader: _emscripten_glCompileShader,
  /** @export */
  emscripten_glCompressedTexImage2D: _emscripten_glCompressedTexImage2D,
  /** @export */
  emscripten_glCompressedTexImage3D: _emscripten_glCompressedTexImage3D,
  /** @export */
  emscripten_glCompressedTexSubImage2D: _emscripten_glCompressedTexSubImage2D,
  /** @export */
  emscripten_glCompressedTexSubImage3D: _emscripten_glCompressedTexSubImage3D,
  /** @export */
  emscripten_glCopyBufferSubData: _emscripten_glCopyBufferSubData,
  /** @export */
  emscripten_glCopyTexImage2D: _emscripten_glCopyTexImage2D,
  /** @export */
  emscripten_glCopyTexSubImage2D: _emscripten_glCopyTexSubImage2D,
  /** @export */
  emscripten_glCopyTexSubImage3D: _emscripten_glCopyTexSubImage3D,
  /** @export */
  emscripten_glCreateProgram: _emscripten_glCreateProgram,
  /** @export */
  emscripten_glCreateShader: _emscripten_glCreateShader,
  /** @export */
  emscripten_glCullFace: _emscripten_glCullFace,
  /** @export */
  emscripten_glDeleteBuffers: _emscripten_glDeleteBuffers,
  /** @export */
  emscripten_glDeleteFramebuffers: _emscripten_glDeleteFramebuffers,
  /** @export */
  emscripten_glDeleteProgram: _emscripten_glDeleteProgram,
  /** @export */
  emscripten_glDeleteQueries: _emscripten_glDeleteQueries,
  /** @export */
  emscripten_glDeleteQueriesEXT: _emscripten_glDeleteQueriesEXT,
  /** @export */
  emscripten_glDeleteRenderbuffers: _emscripten_glDeleteRenderbuffers,
  /** @export */
  emscripten_glDeleteSamplers: _emscripten_glDeleteSamplers,
  /** @export */
  emscripten_glDeleteShader: _emscripten_glDeleteShader,
  /** @export */
  emscripten_glDeleteSync: _emscripten_glDeleteSync,
  /** @export */
  emscripten_glDeleteTextures: _emscripten_glDeleteTextures,
  /** @export */
  emscripten_glDeleteTransformFeedbacks: _emscripten_glDeleteTransformFeedbacks,
  /** @export */
  emscripten_glDeleteVertexArrays: _emscripten_glDeleteVertexArrays,
  /** @export */
  emscripten_glDeleteVertexArraysOES: _emscripten_glDeleteVertexArraysOES,
  /** @export */
  emscripten_glDepthFunc: _emscripten_glDepthFunc,
  /** @export */
  emscripten_glDepthMask: _emscripten_glDepthMask,
  /** @export */
  emscripten_glDepthRangef: _emscripten_glDepthRangef,
  /** @export */
  emscripten_glDetachShader: _emscripten_glDetachShader,
  /** @export */
  emscripten_glDisable: _emscripten_glDisable,
  /** @export */
  emscripten_glDisableVertexAttribArray: _emscripten_glDisableVertexAttribArray,
  /** @export */
  emscripten_glDrawArrays: _emscripten_glDrawArrays,
  /** @export */
  emscripten_glDrawArraysInstanced: _emscripten_glDrawArraysInstanced,
  /** @export */
  emscripten_glDrawArraysInstancedANGLE: _emscripten_glDrawArraysInstancedANGLE,
  /** @export */
  emscripten_glDrawArraysInstancedARB: _emscripten_glDrawArraysInstancedARB,
  /** @export */
  emscripten_glDrawArraysInstancedEXT: _emscripten_glDrawArraysInstancedEXT,
  /** @export */
  emscripten_glDrawArraysInstancedNV: _emscripten_glDrawArraysInstancedNV,
  /** @export */
  emscripten_glDrawBuffers: _emscripten_glDrawBuffers,
  /** @export */
  emscripten_glDrawBuffersEXT: _emscripten_glDrawBuffersEXT,
  /** @export */
  emscripten_glDrawBuffersWEBGL: _emscripten_glDrawBuffersWEBGL,
  /** @export */
  emscripten_glDrawElements: _emscripten_glDrawElements,
  /** @export */
  emscripten_glDrawElementsInstanced: _emscripten_glDrawElementsInstanced,
  /** @export */
  emscripten_glDrawElementsInstancedANGLE: _emscripten_glDrawElementsInstancedANGLE,
  /** @export */
  emscripten_glDrawElementsInstancedARB: _emscripten_glDrawElementsInstancedARB,
  /** @export */
  emscripten_glDrawElementsInstancedEXT: _emscripten_glDrawElementsInstancedEXT,
  /** @export */
  emscripten_glDrawElementsInstancedNV: _emscripten_glDrawElementsInstancedNV,
  /** @export */
  emscripten_glDrawRangeElements: _emscripten_glDrawRangeElements,
  /** @export */
  emscripten_glEnable: _emscripten_glEnable,
  /** @export */
  emscripten_glEnableVertexAttribArray: _emscripten_glEnableVertexAttribArray,
  /** @export */
  emscripten_glEndQuery: _emscripten_glEndQuery,
  /** @export */
  emscripten_glEndQueryEXT: _emscripten_glEndQueryEXT,
  /** @export */
  emscripten_glEndTransformFeedback: _emscripten_glEndTransformFeedback,
  /** @export */
  emscripten_glFenceSync: _emscripten_glFenceSync,
  /** @export */
  emscripten_glFinish: _emscripten_glFinish,
  /** @export */
  emscripten_glFlush: _emscripten_glFlush,
  /** @export */
  emscripten_glFramebufferRenderbuffer: _emscripten_glFramebufferRenderbuffer,
  /** @export */
  emscripten_glFramebufferTexture2D: _emscripten_glFramebufferTexture2D,
  /** @export */
  emscripten_glFramebufferTextureLayer: _emscripten_glFramebufferTextureLayer,
  /** @export */
  emscripten_glFrontFace: _emscripten_glFrontFace,
  /** @export */
  emscripten_glGenBuffers: _emscripten_glGenBuffers,
  /** @export */
  emscripten_glGenFramebuffers: _emscripten_glGenFramebuffers,
  /** @export */
  emscripten_glGenQueries: _emscripten_glGenQueries,
  /** @export */
  emscripten_glGenQueriesEXT: _emscripten_glGenQueriesEXT,
  /** @export */
  emscripten_glGenRenderbuffers: _emscripten_glGenRenderbuffers,
  /** @export */
  emscripten_glGenSamplers: _emscripten_glGenSamplers,
  /** @export */
  emscripten_glGenTextures: _emscripten_glGenTextures,
  /** @export */
  emscripten_glGenTransformFeedbacks: _emscripten_glGenTransformFeedbacks,
  /** @export */
  emscripten_glGenVertexArrays: _emscripten_glGenVertexArrays,
  /** @export */
  emscripten_glGenVertexArraysOES: _emscripten_glGenVertexArraysOES,
  /** @export */
  emscripten_glGenerateMipmap: _emscripten_glGenerateMipmap,
  /** @export */
  emscripten_glGetActiveAttrib: _emscripten_glGetActiveAttrib,
  /** @export */
  emscripten_glGetActiveUniform: _emscripten_glGetActiveUniform,
  /** @export */
  emscripten_glGetActiveUniformBlockName: _emscripten_glGetActiveUniformBlockName,
  /** @export */
  emscripten_glGetActiveUniformBlockiv: _emscripten_glGetActiveUniformBlockiv,
  /** @export */
  emscripten_glGetActiveUniformsiv: _emscripten_glGetActiveUniformsiv,
  /** @export */
  emscripten_glGetAttachedShaders: _emscripten_glGetAttachedShaders,
  /** @export */
  emscripten_glGetAttribLocation: _emscripten_glGetAttribLocation,
  /** @export */
  emscripten_glGetBooleanv: _emscripten_glGetBooleanv,
  /** @export */
  emscripten_glGetBufferParameteri64v: _emscripten_glGetBufferParameteri64v,
  /** @export */
  emscripten_glGetBufferParameteriv: _emscripten_glGetBufferParameteriv,
  /** @export */
  emscripten_glGetError: _emscripten_glGetError,
  /** @export */
  emscripten_glGetFloatv: _emscripten_glGetFloatv,
  /** @export */
  emscripten_glGetFragDataLocation: _emscripten_glGetFragDataLocation,
  /** @export */
  emscripten_glGetFramebufferAttachmentParameteriv: _emscripten_glGetFramebufferAttachmentParameteriv,
  /** @export */
  emscripten_glGetInteger64i_v: _emscripten_glGetInteger64i_v,
  /** @export */
  emscripten_glGetInteger64v: _emscripten_glGetInteger64v,
  /** @export */
  emscripten_glGetIntegeri_v: _emscripten_glGetIntegeri_v,
  /** @export */
  emscripten_glGetIntegerv: _emscripten_glGetIntegerv,
  /** @export */
  emscripten_glGetInternalformativ: _emscripten_glGetInternalformativ,
  /** @export */
  emscripten_glGetProgramBinary: _emscripten_glGetProgramBinary,
  /** @export */
  emscripten_glGetProgramInfoLog: _emscripten_glGetProgramInfoLog,
  /** @export */
  emscripten_glGetProgramiv: _emscripten_glGetProgramiv,
  /** @export */
  emscripten_glGetQueryObjecti64vEXT: _emscripten_glGetQueryObjecti64vEXT,
  /** @export */
  emscripten_glGetQueryObjectivEXT: _emscripten_glGetQueryObjectivEXT,
  /** @export */
  emscripten_glGetQueryObjectui64vEXT: _emscripten_glGetQueryObjectui64vEXT,
  /** @export */
  emscripten_glGetQueryObjectuiv: _emscripten_glGetQueryObjectuiv,
  /** @export */
  emscripten_glGetQueryObjectuivEXT: _emscripten_glGetQueryObjectuivEXT,
  /** @export */
  emscripten_glGetQueryiv: _emscripten_glGetQueryiv,
  /** @export */
  emscripten_glGetQueryivEXT: _emscripten_glGetQueryivEXT,
  /** @export */
  emscripten_glGetRenderbufferParameteriv: _emscripten_glGetRenderbufferParameteriv,
  /** @export */
  emscripten_glGetSamplerParameterfv: _emscripten_glGetSamplerParameterfv,
  /** @export */
  emscripten_glGetSamplerParameteriv: _emscripten_glGetSamplerParameteriv,
  /** @export */
  emscripten_glGetShaderInfoLog: _emscripten_glGetShaderInfoLog,
  /** @export */
  emscripten_glGetShaderPrecisionFormat: _emscripten_glGetShaderPrecisionFormat,
  /** @export */
  emscripten_glGetShaderSource: _emscripten_glGetShaderSource,
  /** @export */
  emscripten_glGetShaderiv: _emscripten_glGetShaderiv,
  /** @export */
  emscripten_glGetString: _emscripten_glGetString,
  /** @export */
  emscripten_glGetStringi: _emscripten_glGetStringi,
  /** @export */
  emscripten_glGetSynciv: _emscripten_glGetSynciv,
  /** @export */
  emscripten_glGetTexParameterfv: _emscripten_glGetTexParameterfv,
  /** @export */
  emscripten_glGetTexParameteriv: _emscripten_glGetTexParameteriv,
  /** @export */
  emscripten_glGetTransformFeedbackVarying: _emscripten_glGetTransformFeedbackVarying,
  /** @export */
  emscripten_glGetUniformBlockIndex: _emscripten_glGetUniformBlockIndex,
  /** @export */
  emscripten_glGetUniformIndices: _emscripten_glGetUniformIndices,
  /** @export */
  emscripten_glGetUniformLocation: _emscripten_glGetUniformLocation,
  /** @export */
  emscripten_glGetUniformfv: _emscripten_glGetUniformfv,
  /** @export */
  emscripten_glGetUniformiv: _emscripten_glGetUniformiv,
  /** @export */
  emscripten_glGetUniformuiv: _emscripten_glGetUniformuiv,
  /** @export */
  emscripten_glGetVertexAttribIiv: _emscripten_glGetVertexAttribIiv,
  /** @export */
  emscripten_glGetVertexAttribIuiv: _emscripten_glGetVertexAttribIuiv,
  /** @export */
  emscripten_glGetVertexAttribPointerv: _emscripten_glGetVertexAttribPointerv,
  /** @export */
  emscripten_glGetVertexAttribfv: _emscripten_glGetVertexAttribfv,
  /** @export */
  emscripten_glGetVertexAttribiv: _emscripten_glGetVertexAttribiv,
  /** @export */
  emscripten_glHint: _emscripten_glHint,
  /** @export */
  emscripten_glInvalidateFramebuffer: _emscripten_glInvalidateFramebuffer,
  /** @export */
  emscripten_glInvalidateSubFramebuffer: _emscripten_glInvalidateSubFramebuffer,
  /** @export */
  emscripten_glIsBuffer: _emscripten_glIsBuffer,
  /** @export */
  emscripten_glIsEnabled: _emscripten_glIsEnabled,
  /** @export */
  emscripten_glIsFramebuffer: _emscripten_glIsFramebuffer,
  /** @export */
  emscripten_glIsProgram: _emscripten_glIsProgram,
  /** @export */
  emscripten_glIsQuery: _emscripten_glIsQuery,
  /** @export */
  emscripten_glIsQueryEXT: _emscripten_glIsQueryEXT,
  /** @export */
  emscripten_glIsRenderbuffer: _emscripten_glIsRenderbuffer,
  /** @export */
  emscripten_glIsSampler: _emscripten_glIsSampler,
  /** @export */
  emscripten_glIsShader: _emscripten_glIsShader,
  /** @export */
  emscripten_glIsSync: _emscripten_glIsSync,
  /** @export */
  emscripten_glIsTexture: _emscripten_glIsTexture,
  /** @export */
  emscripten_glIsTransformFeedback: _emscripten_glIsTransformFeedback,
  /** @export */
  emscripten_glIsVertexArray: _emscripten_glIsVertexArray,
  /** @export */
  emscripten_glIsVertexArrayOES: _emscripten_glIsVertexArrayOES,
  /** @export */
  emscripten_glLineWidth: _emscripten_glLineWidth,
  /** @export */
  emscripten_glLinkProgram: _emscripten_glLinkProgram,
  /** @export */
  emscripten_glPauseTransformFeedback: _emscripten_glPauseTransformFeedback,
  /** @export */
  emscripten_glPixelStorei: _emscripten_glPixelStorei,
  /** @export */
  emscripten_glPolygonOffset: _emscripten_glPolygonOffset,
  /** @export */
  emscripten_glProgramBinary: _emscripten_glProgramBinary,
  /** @export */
  emscripten_glProgramParameteri: _emscripten_glProgramParameteri,
  /** @export */
  emscripten_glQueryCounterEXT: _emscripten_glQueryCounterEXT,
  /** @export */
  emscripten_glReadBuffer: _emscripten_glReadBuffer,
  /** @export */
  emscripten_glReadPixels: _emscripten_glReadPixels,
  /** @export */
  emscripten_glReleaseShaderCompiler: _emscripten_glReleaseShaderCompiler,
  /** @export */
  emscripten_glRenderbufferStorage: _emscripten_glRenderbufferStorage,
  /** @export */
  emscripten_glRenderbufferStorageMultisample: _emscripten_glRenderbufferStorageMultisample,
  /** @export */
  emscripten_glResumeTransformFeedback: _emscripten_glResumeTransformFeedback,
  /** @export */
  emscripten_glSampleCoverage: _emscripten_glSampleCoverage,
  /** @export */
  emscripten_glSamplerParameterf: _emscripten_glSamplerParameterf,
  /** @export */
  emscripten_glSamplerParameterfv: _emscripten_glSamplerParameterfv,
  /** @export */
  emscripten_glSamplerParameteri: _emscripten_glSamplerParameteri,
  /** @export */
  emscripten_glSamplerParameteriv: _emscripten_glSamplerParameteriv,
  /** @export */
  emscripten_glScissor: _emscripten_glScissor,
  /** @export */
  emscripten_glShaderBinary: _emscripten_glShaderBinary,
  /** @export */
  emscripten_glShaderSource: _emscripten_glShaderSource,
  /** @export */
  emscripten_glStencilFunc: _emscripten_glStencilFunc,
  /** @export */
  emscripten_glStencilFuncSeparate: _emscripten_glStencilFuncSeparate,
  /** @export */
  emscripten_glStencilMask: _emscripten_glStencilMask,
  /** @export */
  emscripten_glStencilMaskSeparate: _emscripten_glStencilMaskSeparate,
  /** @export */
  emscripten_glStencilOp: _emscripten_glStencilOp,
  /** @export */
  emscripten_glStencilOpSeparate: _emscripten_glStencilOpSeparate,
  /** @export */
  emscripten_glTexImage2D: _emscripten_glTexImage2D,
  /** @export */
  emscripten_glTexImage3D: _emscripten_glTexImage3D,
  /** @export */
  emscripten_glTexParameterf: _emscripten_glTexParameterf,
  /** @export */
  emscripten_glTexParameterfv: _emscripten_glTexParameterfv,
  /** @export */
  emscripten_glTexParameteri: _emscripten_glTexParameteri,
  /** @export */
  emscripten_glTexParameteriv: _emscripten_glTexParameteriv,
  /** @export */
  emscripten_glTexStorage2D: _emscripten_glTexStorage2D,
  /** @export */
  emscripten_glTexStorage3D: _emscripten_glTexStorage3D,
  /** @export */
  emscripten_glTexSubImage2D: _emscripten_glTexSubImage2D,
  /** @export */
  emscripten_glTexSubImage3D: _emscripten_glTexSubImage3D,
  /** @export */
  emscripten_glTransformFeedbackVaryings: _emscripten_glTransformFeedbackVaryings,
  /** @export */
  emscripten_glUniform1f: _emscripten_glUniform1f,
  /** @export */
  emscripten_glUniform1fv: _emscripten_glUniform1fv,
  /** @export */
  emscripten_glUniform1i: _emscripten_glUniform1i,
  /** @export */
  emscripten_glUniform1iv: _emscripten_glUniform1iv,
  /** @export */
  emscripten_glUniform1ui: _emscripten_glUniform1ui,
  /** @export */
  emscripten_glUniform1uiv: _emscripten_glUniform1uiv,
  /** @export */
  emscripten_glUniform2f: _emscripten_glUniform2f,
  /** @export */
  emscripten_glUniform2fv: _emscripten_glUniform2fv,
  /** @export */
  emscripten_glUniform2i: _emscripten_glUniform2i,
  /** @export */
  emscripten_glUniform2iv: _emscripten_glUniform2iv,
  /** @export */
  emscripten_glUniform2ui: _emscripten_glUniform2ui,
  /** @export */
  emscripten_glUniform2uiv: _emscripten_glUniform2uiv,
  /** @export */
  emscripten_glUniform3f: _emscripten_glUniform3f,
  /** @export */
  emscripten_glUniform3fv: _emscripten_glUniform3fv,
  /** @export */
  emscripten_glUniform3i: _emscripten_glUniform3i,
  /** @export */
  emscripten_glUniform3iv: _emscripten_glUniform3iv,
  /** @export */
  emscripten_glUniform3ui: _emscripten_glUniform3ui,
  /** @export */
  emscripten_glUniform3uiv: _emscripten_glUniform3uiv,
  /** @export */
  emscripten_glUniform4f: _emscripten_glUniform4f,
  /** @export */
  emscripten_glUniform4fv: _emscripten_glUniform4fv,
  /** @export */
  emscripten_glUniform4i: _emscripten_glUniform4i,
  /** @export */
  emscripten_glUniform4iv: _emscripten_glUniform4iv,
  /** @export */
  emscripten_glUniform4ui: _emscripten_glUniform4ui,
  /** @export */
  emscripten_glUniform4uiv: _emscripten_glUniform4uiv,
  /** @export */
  emscripten_glUniformBlockBinding: _emscripten_glUniformBlockBinding,
  /** @export */
  emscripten_glUniformMatrix2fv: _emscripten_glUniformMatrix2fv,
  /** @export */
  emscripten_glUniformMatrix2x3fv: _emscripten_glUniformMatrix2x3fv,
  /** @export */
  emscripten_glUniformMatrix2x4fv: _emscripten_glUniformMatrix2x4fv,
  /** @export */
  emscripten_glUniformMatrix3fv: _emscripten_glUniformMatrix3fv,
  /** @export */
  emscripten_glUniformMatrix3x2fv: _emscripten_glUniformMatrix3x2fv,
  /** @export */
  emscripten_glUniformMatrix3x4fv: _emscripten_glUniformMatrix3x4fv,
  /** @export */
  emscripten_glUniformMatrix4fv: _emscripten_glUniformMatrix4fv,
  /** @export */
  emscripten_glUniformMatrix4x2fv: _emscripten_glUniformMatrix4x2fv,
  /** @export */
  emscripten_glUniformMatrix4x3fv: _emscripten_glUniformMatrix4x3fv,
  /** @export */
  emscripten_glUseProgram: _emscripten_glUseProgram,
  /** @export */
  emscripten_glValidateProgram: _emscripten_glValidateProgram,
  /** @export */
  emscripten_glVertexAttrib1f: _emscripten_glVertexAttrib1f,
  /** @export */
  emscripten_glVertexAttrib1fv: _emscripten_glVertexAttrib1fv,
  /** @export */
  emscripten_glVertexAttrib2f: _emscripten_glVertexAttrib2f,
  /** @export */
  emscripten_glVertexAttrib2fv: _emscripten_glVertexAttrib2fv,
  /** @export */
  emscripten_glVertexAttrib3f: _emscripten_glVertexAttrib3f,
  /** @export */
  emscripten_glVertexAttrib3fv: _emscripten_glVertexAttrib3fv,
  /** @export */
  emscripten_glVertexAttrib4f: _emscripten_glVertexAttrib4f,
  /** @export */
  emscripten_glVertexAttrib4fv: _emscripten_glVertexAttrib4fv,
  /** @export */
  emscripten_glVertexAttribDivisor: _emscripten_glVertexAttribDivisor,
  /** @export */
  emscripten_glVertexAttribDivisorANGLE: _emscripten_glVertexAttribDivisorANGLE,
  /** @export */
  emscripten_glVertexAttribDivisorARB: _emscripten_glVertexAttribDivisorARB,
  /** @export */
  emscripten_glVertexAttribDivisorEXT: _emscripten_glVertexAttribDivisorEXT,
  /** @export */
  emscripten_glVertexAttribDivisorNV: _emscripten_glVertexAttribDivisorNV,
  /** @export */
  emscripten_glVertexAttribI4i: _emscripten_glVertexAttribI4i,
  /** @export */
  emscripten_glVertexAttribI4iv: _emscripten_glVertexAttribI4iv,
  /** @export */
  emscripten_glVertexAttribI4ui: _emscripten_glVertexAttribI4ui,
  /** @export */
  emscripten_glVertexAttribI4uiv: _emscripten_glVertexAttribI4uiv,
  /** @export */
  emscripten_glVertexAttribIPointer: _emscripten_glVertexAttribIPointer,
  /** @export */
  emscripten_glVertexAttribPointer: _emscripten_glVertexAttribPointer,
  /** @export */
  emscripten_glViewport: _emscripten_glViewport,
  /** @export */
  emscripten_glWaitSync: _emscripten_glWaitSync,
  /** @export */
  emscripten_has_asyncify: _emscripten_has_asyncify,
  /** @export */
  emscripten_num_logical_cores: _emscripten_num_logical_cores,
  /** @export */
  emscripten_request_fullscreen_strategy: _emscripten_request_fullscreen_strategy,
  /** @export */
  emscripten_request_pointerlock: _emscripten_request_pointerlock,
  /** @export */
  emscripten_resize_heap: _emscripten_resize_heap,
  /** @export */
  emscripten_sample_gamepad_data: _emscripten_sample_gamepad_data,
  /** @export */
  emscripten_set_beforeunload_callback_on_thread: _emscripten_set_beforeunload_callback_on_thread,
  /** @export */
  emscripten_set_blur_callback_on_thread: _emscripten_set_blur_callback_on_thread,
  /** @export */
  emscripten_set_canvas_element_size: _emscripten_set_canvas_element_size,
  /** @export */
  emscripten_set_devicemotion_callback_on_thread: _emscripten_set_devicemotion_callback_on_thread,
  /** @export */
  emscripten_set_element_css_size: _emscripten_set_element_css_size,
  /** @export */
  emscripten_set_focus_callback_on_thread: _emscripten_set_focus_callback_on_thread,
  /** @export */
  emscripten_set_fullscreenchange_callback_on_thread: _emscripten_set_fullscreenchange_callback_on_thread,
  /** @export */
  emscripten_set_gamepadconnected_callback_on_thread: _emscripten_set_gamepadconnected_callback_on_thread,
  /** @export */
  emscripten_set_gamepaddisconnected_callback_on_thread: _emscripten_set_gamepaddisconnected_callback_on_thread,
  /** @export */
  emscripten_set_keydown_callback_on_thread: _emscripten_set_keydown_callback_on_thread,
  /** @export */
  emscripten_set_keypress_callback_on_thread: _emscripten_set_keypress_callback_on_thread,
  /** @export */
  emscripten_set_keyup_callback_on_thread: _emscripten_set_keyup_callback_on_thread,
  /** @export */
  emscripten_set_main_loop: _emscripten_set_main_loop,
  /** @export */
  emscripten_set_main_loop_timing: _emscripten_set_main_loop_timing,
  /** @export */
  emscripten_set_orientationchange_callback_on_thread: _emscripten_set_orientationchange_callback_on_thread,
  /** @export */
  emscripten_set_pointerlockchange_callback_on_thread: _emscripten_set_pointerlockchange_callback_on_thread,
  /** @export */
  emscripten_set_resize_callback_on_thread: _emscripten_set_resize_callback_on_thread,
  /** @export */
  emscripten_set_timeout: _emscripten_set_timeout,
  /** @export */
  emscripten_set_visibilitychange_callback_on_thread: _emscripten_set_visibilitychange_callback_on_thread,
  /** @export */
  emscripten_set_wheel_callback_on_thread: _emscripten_set_wheel_callback_on_thread,
  /** @export */
  emscripten_set_window_title: _emscripten_set_window_title,
  /** @export */
  emscripten_sleep: _emscripten_sleep,
  /** @export */
  emscripten_unwind_to_js_event_loop: _emscripten_unwind_to_js_event_loop,
  /** @export */
  emscripten_webgl_create_context: _emscripten_webgl_create_context,
  /** @export */
  emscripten_webgl_destroy_context: _emscripten_webgl_destroy_context,
  /** @export */
  emscripten_webgl_make_context_current: _emscripten_webgl_make_context_current,
  /** @export */
  environ_get: _environ_get,
  /** @export */
  environ_sizes_get: _environ_sizes_get,
  /** @export */
  exit: _exit,
  /** @export */
  fd_close: _fd_close,
  /** @export */
  fd_fdstat_get: _fd_fdstat_get,
  /** @export */
  fd_pread: _fd_pread,
  /** @export */
  fd_pwrite: _fd_pwrite,
  /** @export */
  fd_read: _fd_read,
  /** @export */
  fd_seek: _fd_seek,
  /** @export */
  fd_sync: _fd_sync,
  /** @export */
  fd_write: _fd_write,
  /** @export */
  getentropy: _getentropy,
  /** @export */
  memory: wasmMemory || Module['wasmMemory'],
  /** @export */
  mono_interp_tier_prepare_jiterpreter: _mono_interp_tier_prepare_jiterpreter,
  /** @export */
  mono_wasm_browser_entropy: _mono_wasm_browser_entropy,
  /** @export */
  mono_wasm_cancel_promise: _mono_wasm_cancel_promise,
  /** @export */
  mono_wasm_console_clear: _mono_wasm_console_clear,
  /** @export */
  mono_wasm_dump_threads: _mono_wasm_dump_threads,
  /** @export */
  mono_wasm_free_method_data: _mono_wasm_free_method_data,
  /** @export */
  mono_wasm_get_locale_info: _mono_wasm_get_locale_info,
  /** @export */
  mono_wasm_install_js_worker_interop: _mono_wasm_install_js_worker_interop,
  /** @export */
  mono_wasm_invoke_js_function: _mono_wasm_invoke_js_function,
  /** @export */
  mono_wasm_invoke_jsimport_MT: _mono_wasm_invoke_jsimport_MT,
  /** @export */
  mono_wasm_process_current_pid: _mono_wasm_process_current_pid,
  /** @export */
  mono_wasm_pthread_on_pthread_attached: _mono_wasm_pthread_on_pthread_attached,
  /** @export */
  mono_wasm_pthread_on_pthread_registered: _mono_wasm_pthread_on_pthread_registered,
  /** @export */
  mono_wasm_pthread_on_pthread_unregistered: _mono_wasm_pthread_on_pthread_unregistered,
  /** @export */
  mono_wasm_pthread_set_name: _mono_wasm_pthread_set_name,
  /** @export */
  mono_wasm_release_cs_owned_object: _mono_wasm_release_cs_owned_object,
  /** @export */
  mono_wasm_resolve_or_reject_promise: _mono_wasm_resolve_or_reject_promise,
  /** @export */
  mono_wasm_schedule_synchronization_context: _mono_wasm_schedule_synchronization_context,
  /** @export */
  mono_wasm_set_entrypoint_breakpoint: _mono_wasm_set_entrypoint_breakpoint,
  /** @export */
  mono_wasm_start_deputy_thread_async: _mono_wasm_start_deputy_thread_async,
  /** @export */
  mono_wasm_start_io_thread_async: _mono_wasm_start_io_thread_async,
  /** @export */
  mono_wasm_trace_logger: _mono_wasm_trace_logger,
  /** @export */
  mono_wasm_uninstall_js_worker_interop: _mono_wasm_uninstall_js_worker_interop,
  /** @export */
  mono_wasm_warn_about_blocking_wait: _mono_wasm_warn_about_blocking_wait,
  /** @export */
  proc_exit: _proc_exit,
  /** @export */
  strftime: _strftime
};
var wasmExports = createWasm();
var ___wasm_call_ctors = () => (___wasm_call_ctors = wasmExports['__wasm_call_ctors'])();
var _p3_sdl2_keepalive = Module['_p3_sdl2_keepalive'] = () => (_p3_sdl2_keepalive = Module['_p3_sdl2_keepalive'] = wasmExports['p3_sdl2_keepalive'])();
var _p3_native_keepalive = Module['_p3_native_keepalive'] = () => (_p3_native_keepalive = Module['_p3_native_keepalive'] = wasmExports['p3_native_keepalive'])();
var _p4d_sdl3_marker = Module['_p4d_sdl3_marker'] = () => (_p4d_sdl3_marker = Module['_p4d_sdl3_marker'] = wasmExports['p4d_sdl3_marker'])();
var _wasm_push_key = Module['_wasm_push_key'] = (a0, a1, a2, a3, a4) => (_wasm_push_key = Module['_wasm_push_key'] = wasmExports['wasm_push_key'])(a0, a1, a2, a3, a4);
var _wasm_push_text = Module['_wasm_push_text'] = (a0) => (_wasm_push_text = Module['_wasm_push_text'] = wasmExports['wasm_push_text'])(a0);
var _wasm_push_mouse_motion = Module['_wasm_push_mouse_motion'] = (a0, a1, a2, a3, a4) => (_wasm_push_mouse_motion = Module['_wasm_push_mouse_motion'] = wasmExports['wasm_push_mouse_motion'])(a0, a1, a2, a3, a4);
var _wasm_push_mouse_button = Module['_wasm_push_mouse_button'] = (a0, a1, a2, a3) => (_wasm_push_mouse_button = Module['_wasm_push_mouse_button'] = wasmExports['wasm_push_mouse_button'])(a0, a1, a2, a3);
var _wasm_push_mouse_wheel = Module['_wasm_push_mouse_wheel'] = (a0, a1, a2, a3) => (_wasm_push_mouse_wheel = Module['_wasm_push_mouse_wheel'] = wasmExports['wasm_push_mouse_wheel'])(a0, a1, a2, a3);
var _wasm_push_mouse_in_window = Module['_wasm_push_mouse_in_window'] = (a0) => (_wasm_push_mouse_in_window = Module['_wasm_push_mouse_in_window'] = wasmExports['wasm_push_mouse_in_window'])(a0);
var _wasm_push_window_focus = Module['_wasm_push_window_focus'] = (a0) => (_wasm_push_window_focus = Module['_wasm_push_window_focus'] = wasmExports['wasm_push_window_focus'])(a0);
var _sdl3_drain_events = Module['_sdl3_drain_events'] = (a0, a1) => (_sdl3_drain_events = Module['_sdl3_drain_events'] = wasmExports['sdl3_drain_events'])(a0, a1);
var _sdl3_dropped_events = Module['_sdl3_dropped_events'] = () => (_sdl3_dropped_events = Module['_sdl3_dropped_events'] = wasmExports['sdl3_dropped_events'])();
var _wasm_flush_idbfs = Module['_wasm_flush_idbfs'] = () => (_wasm_flush_idbfs = Module['_wasm_flush_idbfs'] = wasmExports['wasm_flush_idbfs'])();
var _sdl3_SDL_GetWindowDisplayScale = Module['_sdl3_SDL_GetWindowDisplayScale'] = (a0) => (_sdl3_SDL_GetWindowDisplayScale = Module['_sdl3_SDL_GetWindowDisplayScale'] = wasmExports['sdl3_SDL_GetWindowDisplayScale'])(a0);
var _sdl3_SDL_GetMouseState = Module['_sdl3_SDL_GetMouseState'] = (a0, a1) => (_sdl3_SDL_GetMouseState = Module['_sdl3_SDL_GetMouseState'] = wasmExports['sdl3_SDL_GetMouseState'])(a0, a1);
var _sdl3_SDL_GetGlobalMouseState = Module['_sdl3_SDL_GetGlobalMouseState'] = (a0, a1) => (_sdl3_SDL_GetGlobalMouseState = Module['_sdl3_SDL_GetGlobalMouseState'] = wasmExports['sdl3_SDL_GetGlobalMouseState'])(a0, a1);
var _sdl3_SDL_GetWindowPosition = Module['_sdl3_SDL_GetWindowPosition'] = (a0, a1, a2) => (_sdl3_SDL_GetWindowPosition = Module['_sdl3_SDL_GetWindowPosition'] = wasmExports['sdl3_SDL_GetWindowPosition'])(a0, a1, a2);
var _wasm_play_pcm = Module['_wasm_play_pcm'] = (a0, a1, a2, a3, a4, a5) => (_wasm_play_pcm = Module['_wasm_play_pcm'] = wasmExports['wasm_play_pcm'])(a0, a1, a2, a3, a4, a5);
var _wasm_play_music = Module['_wasm_play_music'] = (a0, a1, a2, a3) => (_wasm_play_music = Module['_wasm_play_music'] = wasmExports['wasm_play_music'])(a0, a1, a2, a3);
var _wasm_stop_sound = Module['_wasm_stop_sound'] = (a0) => (_wasm_stop_sound = Module['_wasm_stop_sound'] = wasmExports['wasm_stop_sound'])(a0);
var _wasm_set_sound_volume = Module['_wasm_set_sound_volume'] = (a0, a1) => (_wasm_set_sound_volume = Module['_wasm_set_sound_volume'] = wasmExports['wasm_set_sound_volume'])(a0, a1);
var _wasm_signal_event = Module['_wasm_signal_event'] = (a0) => (_wasm_signal_event = Module['_wasm_signal_event'] = wasmExports['wasm_signal_event'])(a0);
var _wasm_signal_event_async = Module['_wasm_signal_event_async'] = (a0) => (_wasm_signal_event_async = Module['_wasm_signal_event_async'] = wasmExports['wasm_signal_event_async'])(a0);
var _wasm_clipboard_set = Module['_wasm_clipboard_set'] = (a0, a1) => (_wasm_clipboard_set = Module['_wasm_clipboard_set'] = wasmExports['wasm_clipboard_set'])(a0, a1);
var _wasm_clipboard_get = Module['_wasm_clipboard_get'] = (a0, a1) => (_wasm_clipboard_get = Module['_wasm_clipboard_get'] = wasmExports['wasm_clipboard_get'])(a0, a1);
var _wasm_play_music_url = Module['_wasm_play_music_url'] = (a0, a1, a2) => (_wasm_play_music_url = Module['_wasm_play_music_url'] = wasmExports['wasm_play_music_url'])(a0, a1, a2);
var _sdl3_SDL_AcquireCameraFrame = Module['_sdl3_SDL_AcquireCameraFrame'] = (a0, a1) => (_sdl3_SDL_AcquireCameraFrame = Module['_sdl3_SDL_AcquireCameraFrame'] = wasmExports['sdl3_SDL_AcquireCameraFrame'])(a0, a1);
var _sdl3_SDL_AcquireGPUCommandBuffer = Module['_sdl3_SDL_AcquireGPUCommandBuffer'] = (a0) => (_sdl3_SDL_AcquireGPUCommandBuffer = Module['_sdl3_SDL_AcquireGPUCommandBuffer'] = wasmExports['sdl3_SDL_AcquireGPUCommandBuffer'])(a0);
var _sdl3_SDL_AcquireGPUSwapchainTexture = Module['_sdl3_SDL_AcquireGPUSwapchainTexture'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_AcquireGPUSwapchainTexture = Module['_sdl3_SDL_AcquireGPUSwapchainTexture'] = wasmExports['sdl3_SDL_AcquireGPUSwapchainTexture'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_AddAtomicInt = Module['_sdl3_SDL_AddAtomicInt'] = (a0, a1) => (_sdl3_SDL_AddAtomicInt = Module['_sdl3_SDL_AddAtomicInt'] = wasmExports['sdl3_SDL_AddAtomicInt'])(a0, a1);
var _sdl3_SDL_AddEventWatch = Module['_sdl3_SDL_AddEventWatch'] = (a0, a1) => (_sdl3_SDL_AddEventWatch = Module['_sdl3_SDL_AddEventWatch'] = wasmExports['sdl3_SDL_AddEventWatch'])(a0, a1);
var _sdl3_SDL_AddGamepadMapping = Module['_sdl3_SDL_AddGamepadMapping'] = (a0) => (_sdl3_SDL_AddGamepadMapping = Module['_sdl3_SDL_AddGamepadMapping'] = wasmExports['sdl3_SDL_AddGamepadMapping'])(a0);
var _sdl3_SDL_AddGamepadMappingsFromFile = Module['_sdl3_SDL_AddGamepadMappingsFromFile'] = (a0) => (_sdl3_SDL_AddGamepadMappingsFromFile = Module['_sdl3_SDL_AddGamepadMappingsFromFile'] = wasmExports['sdl3_SDL_AddGamepadMappingsFromFile'])(a0);
var _sdl3_SDL_AddGamepadMappingsFromIO = Module['_sdl3_SDL_AddGamepadMappingsFromIO'] = (a0, a1) => (_sdl3_SDL_AddGamepadMappingsFromIO = Module['_sdl3_SDL_AddGamepadMappingsFromIO'] = wasmExports['sdl3_SDL_AddGamepadMappingsFromIO'])(a0, a1);
var _sdl3_SDL_AddHintCallback = Module['_sdl3_SDL_AddHintCallback'] = (a0, a1, a2) => (_sdl3_SDL_AddHintCallback = Module['_sdl3_SDL_AddHintCallback'] = wasmExports['sdl3_SDL_AddHintCallback'])(a0, a1, a2);
var _sdl3_SDL_AddSurfaceAlternateImage = Module['_sdl3_SDL_AddSurfaceAlternateImage'] = (a0, a1) => (_sdl3_SDL_AddSurfaceAlternateImage = Module['_sdl3_SDL_AddSurfaceAlternateImage'] = wasmExports['sdl3_SDL_AddSurfaceAlternateImage'])(a0, a1);
var _sdl3_SDL_AddTimer = Module['_sdl3_SDL_AddTimer'] = (a0, a1, a2) => (_sdl3_SDL_AddTimer = Module['_sdl3_SDL_AddTimer'] = wasmExports['sdl3_SDL_AddTimer'])(a0, a1, a2);
var _sdl3_SDL_AddTimerNS = Module['_sdl3_SDL_AddTimerNS'] = (a0, a1, a2) => (_sdl3_SDL_AddTimerNS = Module['_sdl3_SDL_AddTimerNS'] = wasmExports['sdl3_SDL_AddTimerNS'])(a0, a1, a2);
var _sdl3_SDL_AddVulkanRenderSemaphores = Module['_sdl3_SDL_AddVulkanRenderSemaphores'] = (a0, a1, a2, a3) => (_sdl3_SDL_AddVulkanRenderSemaphores = Module['_sdl3_SDL_AddVulkanRenderSemaphores'] = wasmExports['sdl3_SDL_AddVulkanRenderSemaphores'])(a0, a1, a2, a3);
var _sdl3_SDL_AsyncIOFromFile = Module['_sdl3_SDL_AsyncIOFromFile'] = (a0, a1) => (_sdl3_SDL_AsyncIOFromFile = Module['_sdl3_SDL_AsyncIOFromFile'] = wasmExports['sdl3_SDL_AsyncIOFromFile'])(a0, a1);
var _sdl3_SDL_AttachVirtualJoystick = Module['_sdl3_SDL_AttachVirtualJoystick'] = (a0) => (_sdl3_SDL_AttachVirtualJoystick = Module['_sdl3_SDL_AttachVirtualJoystick'] = wasmExports['sdl3_SDL_AttachVirtualJoystick'])(a0);
var _sdl3_SDL_AudioDevicePaused = Module['_sdl3_SDL_AudioDevicePaused'] = (a0) => (_sdl3_SDL_AudioDevicePaused = Module['_sdl3_SDL_AudioDevicePaused'] = wasmExports['sdl3_SDL_AudioDevicePaused'])(a0);
var _sdl3_SDL_AudioStreamDevicePaused = Module['_sdl3_SDL_AudioStreamDevicePaused'] = (a0) => (_sdl3_SDL_AudioStreamDevicePaused = Module['_sdl3_SDL_AudioStreamDevicePaused'] = wasmExports['sdl3_SDL_AudioStreamDevicePaused'])(a0);
var _sdl3_SDL_BeginGPUComputePass = Module['_sdl3_SDL_BeginGPUComputePass'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_BeginGPUComputePass = Module['_sdl3_SDL_BeginGPUComputePass'] = wasmExports['sdl3_SDL_BeginGPUComputePass'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_BeginGPUCopyPass = Module['_sdl3_SDL_BeginGPUCopyPass'] = (a0) => (_sdl3_SDL_BeginGPUCopyPass = Module['_sdl3_SDL_BeginGPUCopyPass'] = wasmExports['sdl3_SDL_BeginGPUCopyPass'])(a0);
var _sdl3_SDL_BeginGPURenderPass = Module['_sdl3_SDL_BeginGPURenderPass'] = (a0, a1, a2, a3) => (_sdl3_SDL_BeginGPURenderPass = Module['_sdl3_SDL_BeginGPURenderPass'] = wasmExports['sdl3_SDL_BeginGPURenderPass'])(a0, a1, a2, a3);
var _sdl3_SDL_BindAudioStream = Module['_sdl3_SDL_BindAudioStream'] = (a0, a1) => (_sdl3_SDL_BindAudioStream = Module['_sdl3_SDL_BindAudioStream'] = wasmExports['sdl3_SDL_BindAudioStream'])(a0, a1);
var _sdl3_SDL_BindAudioStreams = Module['_sdl3_SDL_BindAudioStreams'] = (a0, a1, a2) => (_sdl3_SDL_BindAudioStreams = Module['_sdl3_SDL_BindAudioStreams'] = wasmExports['sdl3_SDL_BindAudioStreams'])(a0, a1, a2);
var _sdl3_SDL_BindGPUComputePipeline = Module['_sdl3_SDL_BindGPUComputePipeline'] = (a0, a1) => (_sdl3_SDL_BindGPUComputePipeline = Module['_sdl3_SDL_BindGPUComputePipeline'] = wasmExports['sdl3_SDL_BindGPUComputePipeline'])(a0, a1);
var _sdl3_SDL_BindGPUComputeSamplers = Module['_sdl3_SDL_BindGPUComputeSamplers'] = (a0, a1, a2, a3) => (_sdl3_SDL_BindGPUComputeSamplers = Module['_sdl3_SDL_BindGPUComputeSamplers'] = wasmExports['sdl3_SDL_BindGPUComputeSamplers'])(a0, a1, a2, a3);
var _sdl3_SDL_BindGPUComputeStorageBuffers = Module['_sdl3_SDL_BindGPUComputeStorageBuffers'] = (a0, a1, a2, a3) => (_sdl3_SDL_BindGPUComputeStorageBuffers = Module['_sdl3_SDL_BindGPUComputeStorageBuffers'] = wasmExports['sdl3_SDL_BindGPUComputeStorageBuffers'])(a0, a1, a2, a3);
var _sdl3_SDL_BindGPUComputeStorageTextures = Module['_sdl3_SDL_BindGPUComputeStorageTextures'] = (a0, a1, a2, a3) => (_sdl3_SDL_BindGPUComputeStorageTextures = Module['_sdl3_SDL_BindGPUComputeStorageTextures'] = wasmExports['sdl3_SDL_BindGPUComputeStorageTextures'])(a0, a1, a2, a3);
var _sdl3_SDL_BindGPUFragmentSamplers = Module['_sdl3_SDL_BindGPUFragmentSamplers'] = (a0, a1, a2, a3) => (_sdl3_SDL_BindGPUFragmentSamplers = Module['_sdl3_SDL_BindGPUFragmentSamplers'] = wasmExports['sdl3_SDL_BindGPUFragmentSamplers'])(a0, a1, a2, a3);
var _sdl3_SDL_BindGPUFragmentStorageBuffers = Module['_sdl3_SDL_BindGPUFragmentStorageBuffers'] = (a0, a1, a2, a3) => (_sdl3_SDL_BindGPUFragmentStorageBuffers = Module['_sdl3_SDL_BindGPUFragmentStorageBuffers'] = wasmExports['sdl3_SDL_BindGPUFragmentStorageBuffers'])(a0, a1, a2, a3);
var _sdl3_SDL_BindGPUFragmentStorageTextures = Module['_sdl3_SDL_BindGPUFragmentStorageTextures'] = (a0, a1, a2, a3) => (_sdl3_SDL_BindGPUFragmentStorageTextures = Module['_sdl3_SDL_BindGPUFragmentStorageTextures'] = wasmExports['sdl3_SDL_BindGPUFragmentStorageTextures'])(a0, a1, a2, a3);
var _sdl3_SDL_BindGPUGraphicsPipeline = Module['_sdl3_SDL_BindGPUGraphicsPipeline'] = (a0, a1) => (_sdl3_SDL_BindGPUGraphicsPipeline = Module['_sdl3_SDL_BindGPUGraphicsPipeline'] = wasmExports['sdl3_SDL_BindGPUGraphicsPipeline'])(a0, a1);
var _sdl3_SDL_BindGPUIndexBuffer = Module['_sdl3_SDL_BindGPUIndexBuffer'] = (a0, a1, a2) => (_sdl3_SDL_BindGPUIndexBuffer = Module['_sdl3_SDL_BindGPUIndexBuffer'] = wasmExports['sdl3_SDL_BindGPUIndexBuffer'])(a0, a1, a2);
var _sdl3_SDL_BindGPUVertexBuffers = Module['_sdl3_SDL_BindGPUVertexBuffers'] = (a0, a1, a2, a3) => (_sdl3_SDL_BindGPUVertexBuffers = Module['_sdl3_SDL_BindGPUVertexBuffers'] = wasmExports['sdl3_SDL_BindGPUVertexBuffers'])(a0, a1, a2, a3);
var _sdl3_SDL_BindGPUVertexSamplers = Module['_sdl3_SDL_BindGPUVertexSamplers'] = (a0, a1, a2, a3) => (_sdl3_SDL_BindGPUVertexSamplers = Module['_sdl3_SDL_BindGPUVertexSamplers'] = wasmExports['sdl3_SDL_BindGPUVertexSamplers'])(a0, a1, a2, a3);
var _sdl3_SDL_BindGPUVertexStorageBuffers = Module['_sdl3_SDL_BindGPUVertexStorageBuffers'] = (a0, a1, a2, a3) => (_sdl3_SDL_BindGPUVertexStorageBuffers = Module['_sdl3_SDL_BindGPUVertexStorageBuffers'] = wasmExports['sdl3_SDL_BindGPUVertexStorageBuffers'])(a0, a1, a2, a3);
var _sdl3_SDL_BindGPUVertexStorageTextures = Module['_sdl3_SDL_BindGPUVertexStorageTextures'] = (a0, a1, a2, a3) => (_sdl3_SDL_BindGPUVertexStorageTextures = Module['_sdl3_SDL_BindGPUVertexStorageTextures'] = wasmExports['sdl3_SDL_BindGPUVertexStorageTextures'])(a0, a1, a2, a3);
var _sdl3_SDL_BlitGPUTexture = Module['_sdl3_SDL_BlitGPUTexture'] = (a0, a1) => (_sdl3_SDL_BlitGPUTexture = Module['_sdl3_SDL_BlitGPUTexture'] = wasmExports['sdl3_SDL_BlitGPUTexture'])(a0, a1);
var _sdl3_SDL_BlitSurface = Module['_sdl3_SDL_BlitSurface'] = (a0, a1, a2, a3) => (_sdl3_SDL_BlitSurface = Module['_sdl3_SDL_BlitSurface'] = wasmExports['sdl3_SDL_BlitSurface'])(a0, a1, a2, a3);
var _sdl3_SDL_BlitSurface9Grid = Module['_sdl3_SDL_BlitSurface9Grid'] = (a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) => (_sdl3_SDL_BlitSurface9Grid = Module['_sdl3_SDL_BlitSurface9Grid'] = wasmExports['sdl3_SDL_BlitSurface9Grid'])(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9);
var _sdl3_SDL_BlitSurfaceScaled = Module['_sdl3_SDL_BlitSurfaceScaled'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_BlitSurfaceScaled = Module['_sdl3_SDL_BlitSurfaceScaled'] = wasmExports['sdl3_SDL_BlitSurfaceScaled'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_BlitSurfaceTiled = Module['_sdl3_SDL_BlitSurfaceTiled'] = (a0, a1, a2, a3) => (_sdl3_SDL_BlitSurfaceTiled = Module['_sdl3_SDL_BlitSurfaceTiled'] = wasmExports['sdl3_SDL_BlitSurfaceTiled'])(a0, a1, a2, a3);
var _sdl3_SDL_BlitSurfaceTiledWithScale = Module['_sdl3_SDL_BlitSurfaceTiledWithScale'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_BlitSurfaceTiledWithScale = Module['_sdl3_SDL_BlitSurfaceTiledWithScale'] = wasmExports['sdl3_SDL_BlitSurfaceTiledWithScale'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_BlitSurfaceUnchecked = Module['_sdl3_SDL_BlitSurfaceUnchecked'] = (a0, a1, a2, a3) => (_sdl3_SDL_BlitSurfaceUnchecked = Module['_sdl3_SDL_BlitSurfaceUnchecked'] = wasmExports['sdl3_SDL_BlitSurfaceUnchecked'])(a0, a1, a2, a3);
var _sdl3_SDL_BlitSurfaceUncheckedScaled = Module['_sdl3_SDL_BlitSurfaceUncheckedScaled'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_BlitSurfaceUncheckedScaled = Module['_sdl3_SDL_BlitSurfaceUncheckedScaled'] = wasmExports['sdl3_SDL_BlitSurfaceUncheckedScaled'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_BroadcastCondition = Module['_sdl3_SDL_BroadcastCondition'] = (a0) => (_sdl3_SDL_BroadcastCondition = Module['_sdl3_SDL_BroadcastCondition'] = wasmExports['sdl3_SDL_BroadcastCondition'])(a0);
var _sdl3_SDL_CalculateGPUTextureFormatSize = Module['_sdl3_SDL_CalculateGPUTextureFormatSize'] = (a0, a1, a2, a3) => (_sdl3_SDL_CalculateGPUTextureFormatSize = Module['_sdl3_SDL_CalculateGPUTextureFormatSize'] = wasmExports['sdl3_SDL_CalculateGPUTextureFormatSize'])(a0, a1, a2, a3);
var _sdl3_SDL_CancelGPUCommandBuffer = Module['_sdl3_SDL_CancelGPUCommandBuffer'] = (a0) => (_sdl3_SDL_CancelGPUCommandBuffer = Module['_sdl3_SDL_CancelGPUCommandBuffer'] = wasmExports['sdl3_SDL_CancelGPUCommandBuffer'])(a0);
var _sdl3_SDL_CaptureMouse = Module['_sdl3_SDL_CaptureMouse'] = (a0) => (_sdl3_SDL_CaptureMouse = Module['_sdl3_SDL_CaptureMouse'] = wasmExports['sdl3_SDL_CaptureMouse'])(a0);
var _sdl3_SDL_ClaimWindowForGPUDevice = Module['_sdl3_SDL_ClaimWindowForGPUDevice'] = (a0, a1) => (_sdl3_SDL_ClaimWindowForGPUDevice = Module['_sdl3_SDL_ClaimWindowForGPUDevice'] = wasmExports['sdl3_SDL_ClaimWindowForGPUDevice'])(a0, a1);
var _sdl3_SDL_CleanupTLS = Module['_sdl3_SDL_CleanupTLS'] = () => (_sdl3_SDL_CleanupTLS = Module['_sdl3_SDL_CleanupTLS'] = wasmExports['sdl3_SDL_CleanupTLS'])();
var _sdl3_SDL_ClearAudioStream = Module['_sdl3_SDL_ClearAudioStream'] = (a0) => (_sdl3_SDL_ClearAudioStream = Module['_sdl3_SDL_ClearAudioStream'] = wasmExports['sdl3_SDL_ClearAudioStream'])(a0);
var _sdl3_SDL_ClearClipboardData = Module['_sdl3_SDL_ClearClipboardData'] = () => (_sdl3_SDL_ClearClipboardData = Module['_sdl3_SDL_ClearClipboardData'] = wasmExports['sdl3_SDL_ClearClipboardData'])();
var _sdl3_SDL_ClearComposition = Module['_sdl3_SDL_ClearComposition'] = (a0) => (_sdl3_SDL_ClearComposition = Module['_sdl3_SDL_ClearComposition'] = wasmExports['sdl3_SDL_ClearComposition'])(a0);
var _sdl3_SDL_ClearError = Module['_sdl3_SDL_ClearError'] = () => (_sdl3_SDL_ClearError = Module['_sdl3_SDL_ClearError'] = wasmExports['sdl3_SDL_ClearError'])();
var _sdl3_SDL_ClearProperty = Module['_sdl3_SDL_ClearProperty'] = (a0, a1) => (_sdl3_SDL_ClearProperty = Module['_sdl3_SDL_ClearProperty'] = wasmExports['sdl3_SDL_ClearProperty'])(a0, a1);
var _sdl3_SDL_ClearSurface = Module['_sdl3_SDL_ClearSurface'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_ClearSurface = Module['_sdl3_SDL_ClearSurface'] = wasmExports['sdl3_SDL_ClearSurface'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_ClickTrayEntry = Module['_sdl3_SDL_ClickTrayEntry'] = (a0) => (_sdl3_SDL_ClickTrayEntry = Module['_sdl3_SDL_ClickTrayEntry'] = wasmExports['sdl3_SDL_ClickTrayEntry'])(a0);
var _sdl3_SDL_CloseAsyncIO = Module['_sdl3_SDL_CloseAsyncIO'] = (a0, a1, a2, a3) => (_sdl3_SDL_CloseAsyncIO = Module['_sdl3_SDL_CloseAsyncIO'] = wasmExports['sdl3_SDL_CloseAsyncIO'])(a0, a1, a2, a3);
var _sdl3_SDL_CloseAudioDevice = Module['_sdl3_SDL_CloseAudioDevice'] = (a0) => (_sdl3_SDL_CloseAudioDevice = Module['_sdl3_SDL_CloseAudioDevice'] = wasmExports['sdl3_SDL_CloseAudioDevice'])(a0);
var _sdl3_SDL_CloseCamera = Module['_sdl3_SDL_CloseCamera'] = (a0) => (_sdl3_SDL_CloseCamera = Module['_sdl3_SDL_CloseCamera'] = wasmExports['sdl3_SDL_CloseCamera'])(a0);
var _sdl3_SDL_CloseGamepad = Module['_sdl3_SDL_CloseGamepad'] = (a0) => (_sdl3_SDL_CloseGamepad = Module['_sdl3_SDL_CloseGamepad'] = wasmExports['sdl3_SDL_CloseGamepad'])(a0);
var _sdl3_SDL_CloseHaptic = Module['_sdl3_SDL_CloseHaptic'] = (a0) => (_sdl3_SDL_CloseHaptic = Module['_sdl3_SDL_CloseHaptic'] = wasmExports['sdl3_SDL_CloseHaptic'])(a0);
var _sdl3_SDL_CloseIO = Module['_sdl3_SDL_CloseIO'] = (a0) => (_sdl3_SDL_CloseIO = Module['_sdl3_SDL_CloseIO'] = wasmExports['sdl3_SDL_CloseIO'])(a0);
var _sdl3_SDL_CloseJoystick = Module['_sdl3_SDL_CloseJoystick'] = (a0) => (_sdl3_SDL_CloseJoystick = Module['_sdl3_SDL_CloseJoystick'] = wasmExports['sdl3_SDL_CloseJoystick'])(a0);
var _sdl3_SDL_CloseSensor = Module['_sdl3_SDL_CloseSensor'] = (a0) => (_sdl3_SDL_CloseSensor = Module['_sdl3_SDL_CloseSensor'] = wasmExports['sdl3_SDL_CloseSensor'])(a0);
var _sdl3_SDL_CloseStorage = Module['_sdl3_SDL_CloseStorage'] = (a0) => (_sdl3_SDL_CloseStorage = Module['_sdl3_SDL_CloseStorage'] = wasmExports['sdl3_SDL_CloseStorage'])(a0);
var _sdl3_SDL_CompareAndSwapAtomicInt = Module['_sdl3_SDL_CompareAndSwapAtomicInt'] = (a0, a1, a2) => (_sdl3_SDL_CompareAndSwapAtomicInt = Module['_sdl3_SDL_CompareAndSwapAtomicInt'] = wasmExports['sdl3_SDL_CompareAndSwapAtomicInt'])(a0, a1, a2);
var _sdl3_SDL_CompareAndSwapAtomicPointer = Module['_sdl3_SDL_CompareAndSwapAtomicPointer'] = (a0, a1, a2) => (_sdl3_SDL_CompareAndSwapAtomicPointer = Module['_sdl3_SDL_CompareAndSwapAtomicPointer'] = wasmExports['sdl3_SDL_CompareAndSwapAtomicPointer'])(a0, a1, a2);
var _sdl3_SDL_CompareAndSwapAtomicU32 = Module['_sdl3_SDL_CompareAndSwapAtomicU32'] = (a0, a1, a2) => (_sdl3_SDL_CompareAndSwapAtomicU32 = Module['_sdl3_SDL_CompareAndSwapAtomicU32'] = wasmExports['sdl3_SDL_CompareAndSwapAtomicU32'])(a0, a1, a2);
var _sdl3_SDL_ComposeCustomBlendMode = Module['_sdl3_SDL_ComposeCustomBlendMode'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_ComposeCustomBlendMode = Module['_sdl3_SDL_ComposeCustomBlendMode'] = wasmExports['sdl3_SDL_ComposeCustomBlendMode'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_ConvertAudioSamples = Module['_sdl3_SDL_ConvertAudioSamples'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_ConvertAudioSamples = Module['_sdl3_SDL_ConvertAudioSamples'] = wasmExports['sdl3_SDL_ConvertAudioSamples'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_ConvertEventToRenderCoordinates = Module['_sdl3_SDL_ConvertEventToRenderCoordinates'] = (a0, a1) => (_sdl3_SDL_ConvertEventToRenderCoordinates = Module['_sdl3_SDL_ConvertEventToRenderCoordinates'] = wasmExports['sdl3_SDL_ConvertEventToRenderCoordinates'])(a0, a1);
var _sdl3_SDL_ConvertPixels = Module['_sdl3_SDL_ConvertPixels'] = (a0, a1, a2, a3, a4, a5, a6, a7) => (_sdl3_SDL_ConvertPixels = Module['_sdl3_SDL_ConvertPixels'] = wasmExports['sdl3_SDL_ConvertPixels'])(a0, a1, a2, a3, a4, a5, a6, a7);
var _sdl3_SDL_ConvertPixelsAndColorspace = Module['_sdl3_SDL_ConvertPixelsAndColorspace'] = (a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) => (_sdl3_SDL_ConvertPixelsAndColorspace = Module['_sdl3_SDL_ConvertPixelsAndColorspace'] = wasmExports['sdl3_SDL_ConvertPixelsAndColorspace'])(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11);
var _sdl3_SDL_ConvertSurface = Module['_sdl3_SDL_ConvertSurface'] = (a0, a1) => (_sdl3_SDL_ConvertSurface = Module['_sdl3_SDL_ConvertSurface'] = wasmExports['sdl3_SDL_ConvertSurface'])(a0, a1);
var _sdl3_SDL_ConvertSurfaceAndColorspace = Module['_sdl3_SDL_ConvertSurfaceAndColorspace'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_ConvertSurfaceAndColorspace = Module['_sdl3_SDL_ConvertSurfaceAndColorspace'] = wasmExports['sdl3_SDL_ConvertSurfaceAndColorspace'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_CopyFile = Module['_sdl3_SDL_CopyFile'] = (a0, a1) => (_sdl3_SDL_CopyFile = Module['_sdl3_SDL_CopyFile'] = wasmExports['sdl3_SDL_CopyFile'])(a0, a1);
var _sdl3_SDL_CopyGPUBufferToBuffer = Module['_sdl3_SDL_CopyGPUBufferToBuffer'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_CopyGPUBufferToBuffer = Module['_sdl3_SDL_CopyGPUBufferToBuffer'] = wasmExports['sdl3_SDL_CopyGPUBufferToBuffer'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_CopyGPUTextureToTexture = Module['_sdl3_SDL_CopyGPUTextureToTexture'] = (a0, a1, a2, a3, a4, a5, a6) => (_sdl3_SDL_CopyGPUTextureToTexture = Module['_sdl3_SDL_CopyGPUTextureToTexture'] = wasmExports['sdl3_SDL_CopyGPUTextureToTexture'])(a0, a1, a2, a3, a4, a5, a6);
var _sdl3_SDL_CopyProperties = Module['_sdl3_SDL_CopyProperties'] = (a0, a1) => (_sdl3_SDL_CopyProperties = Module['_sdl3_SDL_CopyProperties'] = wasmExports['sdl3_SDL_CopyProperties'])(a0, a1);
var _sdl3_SDL_CopyStorageFile = Module['_sdl3_SDL_CopyStorageFile'] = (a0, a1, a2) => (_sdl3_SDL_CopyStorageFile = Module['_sdl3_SDL_CopyStorageFile'] = wasmExports['sdl3_SDL_CopyStorageFile'])(a0, a1, a2);
var _sdl3_SDL_CreateAsyncIOQueue = Module['_sdl3_SDL_CreateAsyncIOQueue'] = () => (_sdl3_SDL_CreateAsyncIOQueue = Module['_sdl3_SDL_CreateAsyncIOQueue'] = wasmExports['sdl3_SDL_CreateAsyncIOQueue'])();
var _sdl3_SDL_CreateAudioStream = Module['_sdl3_SDL_CreateAudioStream'] = (a0, a1) => (_sdl3_SDL_CreateAudioStream = Module['_sdl3_SDL_CreateAudioStream'] = wasmExports['sdl3_SDL_CreateAudioStream'])(a0, a1);
var _sdl3_SDL_CreateColorCursor = Module['_sdl3_SDL_CreateColorCursor'] = (a0, a1, a2) => (_sdl3_SDL_CreateColorCursor = Module['_sdl3_SDL_CreateColorCursor'] = wasmExports['sdl3_SDL_CreateColorCursor'])(a0, a1, a2);
var _sdl3_SDL_CreateCondition = Module['_sdl3_SDL_CreateCondition'] = () => (_sdl3_SDL_CreateCondition = Module['_sdl3_SDL_CreateCondition'] = wasmExports['sdl3_SDL_CreateCondition'])();
var _sdl3_SDL_CreateCursor = Module['_sdl3_SDL_CreateCursor'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_CreateCursor = Module['_sdl3_SDL_CreateCursor'] = wasmExports['sdl3_SDL_CreateCursor'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_CreateDirectory = Module['_sdl3_SDL_CreateDirectory'] = (a0) => (_sdl3_SDL_CreateDirectory = Module['_sdl3_SDL_CreateDirectory'] = wasmExports['sdl3_SDL_CreateDirectory'])(a0);
var _sdl3_SDL_CreateGPUBuffer = Module['_sdl3_SDL_CreateGPUBuffer'] = (a0, a1) => (_sdl3_SDL_CreateGPUBuffer = Module['_sdl3_SDL_CreateGPUBuffer'] = wasmExports['sdl3_SDL_CreateGPUBuffer'])(a0, a1);
var _sdl3_SDL_CreateGPUComputePipeline = Module['_sdl3_SDL_CreateGPUComputePipeline'] = (a0, a1) => (_sdl3_SDL_CreateGPUComputePipeline = Module['_sdl3_SDL_CreateGPUComputePipeline'] = wasmExports['sdl3_SDL_CreateGPUComputePipeline'])(a0, a1);
var _sdl3_SDL_CreateGPUDevice = Module['_sdl3_SDL_CreateGPUDevice'] = (a0, a1, a2) => (_sdl3_SDL_CreateGPUDevice = Module['_sdl3_SDL_CreateGPUDevice'] = wasmExports['sdl3_SDL_CreateGPUDevice'])(a0, a1, a2);
var _sdl3_SDL_CreateGPUDeviceWithProperties = Module['_sdl3_SDL_CreateGPUDeviceWithProperties'] = (a0) => (_sdl3_SDL_CreateGPUDeviceWithProperties = Module['_sdl3_SDL_CreateGPUDeviceWithProperties'] = wasmExports['sdl3_SDL_CreateGPUDeviceWithProperties'])(a0);
var _sdl3_SDL_CreateGPUGraphicsPipeline = Module['_sdl3_SDL_CreateGPUGraphicsPipeline'] = (a0, a1) => (_sdl3_SDL_CreateGPUGraphicsPipeline = Module['_sdl3_SDL_CreateGPUGraphicsPipeline'] = wasmExports['sdl3_SDL_CreateGPUGraphicsPipeline'])(a0, a1);
var _sdl3_SDL_CreateGPUSampler = Module['_sdl3_SDL_CreateGPUSampler'] = (a0, a1) => (_sdl3_SDL_CreateGPUSampler = Module['_sdl3_SDL_CreateGPUSampler'] = wasmExports['sdl3_SDL_CreateGPUSampler'])(a0, a1);
var _sdl3_SDL_CreateGPUShader = Module['_sdl3_SDL_CreateGPUShader'] = (a0, a1) => (_sdl3_SDL_CreateGPUShader = Module['_sdl3_SDL_CreateGPUShader'] = wasmExports['sdl3_SDL_CreateGPUShader'])(a0, a1);
var _sdl3_SDL_CreateGPUTexture = Module['_sdl3_SDL_CreateGPUTexture'] = (a0, a1) => (_sdl3_SDL_CreateGPUTexture = Module['_sdl3_SDL_CreateGPUTexture'] = wasmExports['sdl3_SDL_CreateGPUTexture'])(a0, a1);
var _sdl3_SDL_CreateGPUTransferBuffer = Module['_sdl3_SDL_CreateGPUTransferBuffer'] = (a0, a1) => (_sdl3_SDL_CreateGPUTransferBuffer = Module['_sdl3_SDL_CreateGPUTransferBuffer'] = wasmExports['sdl3_SDL_CreateGPUTransferBuffer'])(a0, a1);
var _sdl3_SDL_CreateHapticEffect = Module['_sdl3_SDL_CreateHapticEffect'] = (a0, a1) => (_sdl3_SDL_CreateHapticEffect = Module['_sdl3_SDL_CreateHapticEffect'] = wasmExports['sdl3_SDL_CreateHapticEffect'])(a0, a1);
var _sdl3_SDL_CreateMutex = Module['_sdl3_SDL_CreateMutex'] = () => (_sdl3_SDL_CreateMutex = Module['_sdl3_SDL_CreateMutex'] = wasmExports['sdl3_SDL_CreateMutex'])();
var _sdl3_SDL_CreatePalette = Module['_sdl3_SDL_CreatePalette'] = (a0) => (_sdl3_SDL_CreatePalette = Module['_sdl3_SDL_CreatePalette'] = wasmExports['sdl3_SDL_CreatePalette'])(a0);
var _sdl3_SDL_CreatePopupWindow = Module['_sdl3_SDL_CreatePopupWindow'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_CreatePopupWindow = Module['_sdl3_SDL_CreatePopupWindow'] = wasmExports['sdl3_SDL_CreatePopupWindow'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_CreateProcess = Module['_sdl3_SDL_CreateProcess'] = (a0, a1) => (_sdl3_SDL_CreateProcess = Module['_sdl3_SDL_CreateProcess'] = wasmExports['sdl3_SDL_CreateProcess'])(a0, a1);
var _sdl3_SDL_CreateProcessWithProperties = Module['_sdl3_SDL_CreateProcessWithProperties'] = (a0) => (_sdl3_SDL_CreateProcessWithProperties = Module['_sdl3_SDL_CreateProcessWithProperties'] = wasmExports['sdl3_SDL_CreateProcessWithProperties'])(a0);
var _sdl3_SDL_CreateProperties = Module['_sdl3_SDL_CreateProperties'] = () => (_sdl3_SDL_CreateProperties = Module['_sdl3_SDL_CreateProperties'] = wasmExports['sdl3_SDL_CreateProperties'])();
var _sdl3_SDL_CreateRWLock = Module['_sdl3_SDL_CreateRWLock'] = () => (_sdl3_SDL_CreateRWLock = Module['_sdl3_SDL_CreateRWLock'] = wasmExports['sdl3_SDL_CreateRWLock'])();
var _sdl3_SDL_CreateRenderer = Module['_sdl3_SDL_CreateRenderer'] = (a0, a1) => (_sdl3_SDL_CreateRenderer = Module['_sdl3_SDL_CreateRenderer'] = wasmExports['sdl3_SDL_CreateRenderer'])(a0, a1);
var _sdl3_SDL_CreateRendererWithProperties = Module['_sdl3_SDL_CreateRendererWithProperties'] = (a0) => (_sdl3_SDL_CreateRendererWithProperties = Module['_sdl3_SDL_CreateRendererWithProperties'] = wasmExports['sdl3_SDL_CreateRendererWithProperties'])(a0);
var _sdl3_SDL_CreateSemaphore = Module['_sdl3_SDL_CreateSemaphore'] = (a0) => (_sdl3_SDL_CreateSemaphore = Module['_sdl3_SDL_CreateSemaphore'] = wasmExports['sdl3_SDL_CreateSemaphore'])(a0);
var _sdl3_SDL_CreateSoftwareRenderer = Module['_sdl3_SDL_CreateSoftwareRenderer'] = (a0) => (_sdl3_SDL_CreateSoftwareRenderer = Module['_sdl3_SDL_CreateSoftwareRenderer'] = wasmExports['sdl3_SDL_CreateSoftwareRenderer'])(a0);
var _sdl3_SDL_CreateStorageDirectory = Module['_sdl3_SDL_CreateStorageDirectory'] = (a0, a1) => (_sdl3_SDL_CreateStorageDirectory = Module['_sdl3_SDL_CreateStorageDirectory'] = wasmExports['sdl3_SDL_CreateStorageDirectory'])(a0, a1);
var _sdl3_SDL_CreateSurface = Module['_sdl3_SDL_CreateSurface'] = (a0, a1, a2) => (_sdl3_SDL_CreateSurface = Module['_sdl3_SDL_CreateSurface'] = wasmExports['sdl3_SDL_CreateSurface'])(a0, a1, a2);
var _sdl3_SDL_CreateSurfaceFrom = Module['_sdl3_SDL_CreateSurfaceFrom'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_CreateSurfaceFrom = Module['_sdl3_SDL_CreateSurfaceFrom'] = wasmExports['sdl3_SDL_CreateSurfaceFrom'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_CreateSurfacePalette = Module['_sdl3_SDL_CreateSurfacePalette'] = (a0) => (_sdl3_SDL_CreateSurfacePalette = Module['_sdl3_SDL_CreateSurfacePalette'] = wasmExports['sdl3_SDL_CreateSurfacePalette'])(a0);
var _sdl3_SDL_CreateSystemCursor = Module['_sdl3_SDL_CreateSystemCursor'] = (a0) => (_sdl3_SDL_CreateSystemCursor = Module['_sdl3_SDL_CreateSystemCursor'] = wasmExports['sdl3_SDL_CreateSystemCursor'])(a0);
var _sdl3_SDL_CreateTexture = Module['_sdl3_SDL_CreateTexture'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_CreateTexture = Module['_sdl3_SDL_CreateTexture'] = wasmExports['sdl3_SDL_CreateTexture'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_CreateTextureFromSurface = Module['_sdl3_SDL_CreateTextureFromSurface'] = (a0, a1) => (_sdl3_SDL_CreateTextureFromSurface = Module['_sdl3_SDL_CreateTextureFromSurface'] = wasmExports['sdl3_SDL_CreateTextureFromSurface'])(a0, a1);
var _sdl3_SDL_CreateTextureWithProperties = Module['_sdl3_SDL_CreateTextureWithProperties'] = (a0, a1) => (_sdl3_SDL_CreateTextureWithProperties = Module['_sdl3_SDL_CreateTextureWithProperties'] = wasmExports['sdl3_SDL_CreateTextureWithProperties'])(a0, a1);
var _sdl3_SDL_CreateThreadRuntime = Module['_sdl3_SDL_CreateThreadRuntime'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_CreateThreadRuntime = Module['_sdl3_SDL_CreateThreadRuntime'] = wasmExports['sdl3_SDL_CreateThreadRuntime'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_CreateThreadWithPropertiesRuntime = Module['_sdl3_SDL_CreateThreadWithPropertiesRuntime'] = (a0, a1, a2) => (_sdl3_SDL_CreateThreadWithPropertiesRuntime = Module['_sdl3_SDL_CreateThreadWithPropertiesRuntime'] = wasmExports['sdl3_SDL_CreateThreadWithPropertiesRuntime'])(a0, a1, a2);
var _sdl3_SDL_CreateTray = Module['_sdl3_SDL_CreateTray'] = (a0, a1) => (_sdl3_SDL_CreateTray = Module['_sdl3_SDL_CreateTray'] = wasmExports['sdl3_SDL_CreateTray'])(a0, a1);
var _sdl3_SDL_CreateTrayMenu = Module['_sdl3_SDL_CreateTrayMenu'] = (a0) => (_sdl3_SDL_CreateTrayMenu = Module['_sdl3_SDL_CreateTrayMenu'] = wasmExports['sdl3_SDL_CreateTrayMenu'])(a0);
var _sdl3_SDL_CreateTraySubmenu = Module['_sdl3_SDL_CreateTraySubmenu'] = (a0) => (_sdl3_SDL_CreateTraySubmenu = Module['_sdl3_SDL_CreateTraySubmenu'] = wasmExports['sdl3_SDL_CreateTraySubmenu'])(a0);
var _sdl3_SDL_CreateWindow = Module['_sdl3_SDL_CreateWindow'] = (a0, a1, a2, a3) => (_sdl3_SDL_CreateWindow = Module['_sdl3_SDL_CreateWindow'] = wasmExports['sdl3_SDL_CreateWindow'])(a0, a1, a2, a3);
var _sdl3_SDL_CreateWindowAndRenderer = Module['_sdl3_SDL_CreateWindowAndRenderer'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_CreateWindowAndRenderer = Module['_sdl3_SDL_CreateWindowAndRenderer'] = wasmExports['sdl3_SDL_CreateWindowAndRenderer'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_CreateWindowWithProperties = Module['_sdl3_SDL_CreateWindowWithProperties'] = (a0) => (_sdl3_SDL_CreateWindowWithProperties = Module['_sdl3_SDL_CreateWindowWithProperties'] = wasmExports['sdl3_SDL_CreateWindowWithProperties'])(a0);
var _sdl3_SDL_CursorVisible = Module['_sdl3_SDL_CursorVisible'] = () => (_sdl3_SDL_CursorVisible = Module['_sdl3_SDL_CursorVisible'] = wasmExports['sdl3_SDL_CursorVisible'])();
var _sdl3_SDL_DateTimeToTime = Module['_sdl3_SDL_DateTimeToTime'] = (a0, a1) => (_sdl3_SDL_DateTimeToTime = Module['_sdl3_SDL_DateTimeToTime'] = wasmExports['sdl3_SDL_DateTimeToTime'])(a0, a1);
var _sdl3_SDL_Delay = Module['_sdl3_SDL_Delay'] = (a0) => (_sdl3_SDL_Delay = Module['_sdl3_SDL_Delay'] = wasmExports['sdl3_SDL_Delay'])(a0);
var _sdl3_SDL_DelayNS = Module['_sdl3_SDL_DelayNS'] = (a0) => (_sdl3_SDL_DelayNS = Module['_sdl3_SDL_DelayNS'] = wasmExports['sdl3_SDL_DelayNS'])(a0);
var _sdl3_SDL_DelayPrecise = Module['_sdl3_SDL_DelayPrecise'] = (a0) => (_sdl3_SDL_DelayPrecise = Module['_sdl3_SDL_DelayPrecise'] = wasmExports['sdl3_SDL_DelayPrecise'])(a0);
var _sdl3_SDL_DestroyAsyncIOQueue = Module['_sdl3_SDL_DestroyAsyncIOQueue'] = (a0) => (_sdl3_SDL_DestroyAsyncIOQueue = Module['_sdl3_SDL_DestroyAsyncIOQueue'] = wasmExports['sdl3_SDL_DestroyAsyncIOQueue'])(a0);
var _sdl3_SDL_DestroyAudioStream = Module['_sdl3_SDL_DestroyAudioStream'] = (a0) => (_sdl3_SDL_DestroyAudioStream = Module['_sdl3_SDL_DestroyAudioStream'] = wasmExports['sdl3_SDL_DestroyAudioStream'])(a0);
var _sdl3_SDL_DestroyCondition = Module['_sdl3_SDL_DestroyCondition'] = (a0) => (_sdl3_SDL_DestroyCondition = Module['_sdl3_SDL_DestroyCondition'] = wasmExports['sdl3_SDL_DestroyCondition'])(a0);
var _sdl3_SDL_DestroyCursor = Module['_sdl3_SDL_DestroyCursor'] = (a0) => (_sdl3_SDL_DestroyCursor = Module['_sdl3_SDL_DestroyCursor'] = wasmExports['sdl3_SDL_DestroyCursor'])(a0);
var _sdl3_SDL_DestroyGPUDevice = Module['_sdl3_SDL_DestroyGPUDevice'] = (a0) => (_sdl3_SDL_DestroyGPUDevice = Module['_sdl3_SDL_DestroyGPUDevice'] = wasmExports['sdl3_SDL_DestroyGPUDevice'])(a0);
var _sdl3_SDL_DestroyHapticEffect = Module['_sdl3_SDL_DestroyHapticEffect'] = (a0, a1) => (_sdl3_SDL_DestroyHapticEffect = Module['_sdl3_SDL_DestroyHapticEffect'] = wasmExports['sdl3_SDL_DestroyHapticEffect'])(a0, a1);
var _sdl3_SDL_DestroyMutex = Module['_sdl3_SDL_DestroyMutex'] = (a0) => (_sdl3_SDL_DestroyMutex = Module['_sdl3_SDL_DestroyMutex'] = wasmExports['sdl3_SDL_DestroyMutex'])(a0);
var _sdl3_SDL_DestroyPalette = Module['_sdl3_SDL_DestroyPalette'] = (a0) => (_sdl3_SDL_DestroyPalette = Module['_sdl3_SDL_DestroyPalette'] = wasmExports['sdl3_SDL_DestroyPalette'])(a0);
var _sdl3_SDL_DestroyProcess = Module['_sdl3_SDL_DestroyProcess'] = (a0) => (_sdl3_SDL_DestroyProcess = Module['_sdl3_SDL_DestroyProcess'] = wasmExports['sdl3_SDL_DestroyProcess'])(a0);
var _sdl3_SDL_DestroyProperties = Module['_sdl3_SDL_DestroyProperties'] = (a0) => (_sdl3_SDL_DestroyProperties = Module['_sdl3_SDL_DestroyProperties'] = wasmExports['sdl3_SDL_DestroyProperties'])(a0);
var _sdl3_SDL_DestroyRWLock = Module['_sdl3_SDL_DestroyRWLock'] = (a0) => (_sdl3_SDL_DestroyRWLock = Module['_sdl3_SDL_DestroyRWLock'] = wasmExports['sdl3_SDL_DestroyRWLock'])(a0);
var _sdl3_SDL_DestroyRenderer = Module['_sdl3_SDL_DestroyRenderer'] = (a0) => (_sdl3_SDL_DestroyRenderer = Module['_sdl3_SDL_DestroyRenderer'] = wasmExports['sdl3_SDL_DestroyRenderer'])(a0);
var _sdl3_SDL_DestroySemaphore = Module['_sdl3_SDL_DestroySemaphore'] = (a0) => (_sdl3_SDL_DestroySemaphore = Module['_sdl3_SDL_DestroySemaphore'] = wasmExports['sdl3_SDL_DestroySemaphore'])(a0);
var _sdl3_SDL_DestroySurface = Module['_sdl3_SDL_DestroySurface'] = (a0) => (_sdl3_SDL_DestroySurface = Module['_sdl3_SDL_DestroySurface'] = wasmExports['sdl3_SDL_DestroySurface'])(a0);
var _sdl3_SDL_DestroyTexture = Module['_sdl3_SDL_DestroyTexture'] = (a0) => (_sdl3_SDL_DestroyTexture = Module['_sdl3_SDL_DestroyTexture'] = wasmExports['sdl3_SDL_DestroyTexture'])(a0);
var _sdl3_SDL_DestroyTray = Module['_sdl3_SDL_DestroyTray'] = (a0) => (_sdl3_SDL_DestroyTray = Module['_sdl3_SDL_DestroyTray'] = wasmExports['sdl3_SDL_DestroyTray'])(a0);
var _sdl3_SDL_DestroyWindow = Module['_sdl3_SDL_DestroyWindow'] = (a0) => (_sdl3_SDL_DestroyWindow = Module['_sdl3_SDL_DestroyWindow'] = wasmExports['sdl3_SDL_DestroyWindow'])(a0);
var _sdl3_SDL_DestroyWindowSurface = Module['_sdl3_SDL_DestroyWindowSurface'] = (a0) => (_sdl3_SDL_DestroyWindowSurface = Module['_sdl3_SDL_DestroyWindowSurface'] = wasmExports['sdl3_SDL_DestroyWindowSurface'])(a0);
var _sdl3_SDL_DetachThread = Module['_sdl3_SDL_DetachThread'] = (a0) => (_sdl3_SDL_DetachThread = Module['_sdl3_SDL_DetachThread'] = wasmExports['sdl3_SDL_DetachThread'])(a0);
var _sdl3_SDL_DetachVirtualJoystick = Module['_sdl3_SDL_DetachVirtualJoystick'] = (a0) => (_sdl3_SDL_DetachVirtualJoystick = Module['_sdl3_SDL_DetachVirtualJoystick'] = wasmExports['sdl3_SDL_DetachVirtualJoystick'])(a0);
var _sdl3_SDL_DisableScreenSaver = Module['_sdl3_SDL_DisableScreenSaver'] = () => (_sdl3_SDL_DisableScreenSaver = Module['_sdl3_SDL_DisableScreenSaver'] = wasmExports['sdl3_SDL_DisableScreenSaver'])();
var _sdl3_SDL_DispatchGPUCompute = Module['_sdl3_SDL_DispatchGPUCompute'] = (a0, a1, a2, a3) => (_sdl3_SDL_DispatchGPUCompute = Module['_sdl3_SDL_DispatchGPUCompute'] = wasmExports['sdl3_SDL_DispatchGPUCompute'])(a0, a1, a2, a3);
var _sdl3_SDL_DispatchGPUComputeIndirect = Module['_sdl3_SDL_DispatchGPUComputeIndirect'] = (a0, a1, a2) => (_sdl3_SDL_DispatchGPUComputeIndirect = Module['_sdl3_SDL_DispatchGPUComputeIndirect'] = wasmExports['sdl3_SDL_DispatchGPUComputeIndirect'])(a0, a1, a2);
var _sdl3_SDL_DownloadFromGPUBuffer = Module['_sdl3_SDL_DownloadFromGPUBuffer'] = (a0, a1, a2) => (_sdl3_SDL_DownloadFromGPUBuffer = Module['_sdl3_SDL_DownloadFromGPUBuffer'] = wasmExports['sdl3_SDL_DownloadFromGPUBuffer'])(a0, a1, a2);
var _sdl3_SDL_DownloadFromGPUTexture = Module['_sdl3_SDL_DownloadFromGPUTexture'] = (a0, a1, a2) => (_sdl3_SDL_DownloadFromGPUTexture = Module['_sdl3_SDL_DownloadFromGPUTexture'] = wasmExports['sdl3_SDL_DownloadFromGPUTexture'])(a0, a1, a2);
var _sdl3_SDL_DrawGPUIndexedPrimitives = Module['_sdl3_SDL_DrawGPUIndexedPrimitives'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_DrawGPUIndexedPrimitives = Module['_sdl3_SDL_DrawGPUIndexedPrimitives'] = wasmExports['sdl3_SDL_DrawGPUIndexedPrimitives'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_DrawGPUIndexedPrimitivesIndirect = Module['_sdl3_SDL_DrawGPUIndexedPrimitivesIndirect'] = (a0, a1, a2, a3) => (_sdl3_SDL_DrawGPUIndexedPrimitivesIndirect = Module['_sdl3_SDL_DrawGPUIndexedPrimitivesIndirect'] = wasmExports['sdl3_SDL_DrawGPUIndexedPrimitivesIndirect'])(a0, a1, a2, a3);
var _sdl3_SDL_DrawGPUPrimitives = Module['_sdl3_SDL_DrawGPUPrimitives'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_DrawGPUPrimitives = Module['_sdl3_SDL_DrawGPUPrimitives'] = wasmExports['sdl3_SDL_DrawGPUPrimitives'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_DrawGPUPrimitivesIndirect = Module['_sdl3_SDL_DrawGPUPrimitivesIndirect'] = (a0, a1, a2, a3) => (_sdl3_SDL_DrawGPUPrimitivesIndirect = Module['_sdl3_SDL_DrawGPUPrimitivesIndirect'] = wasmExports['sdl3_SDL_DrawGPUPrimitivesIndirect'])(a0, a1, a2, a3);
var _sdl3_SDL_DuplicateSurface = Module['_sdl3_SDL_DuplicateSurface'] = (a0) => (_sdl3_SDL_DuplicateSurface = Module['_sdl3_SDL_DuplicateSurface'] = wasmExports['sdl3_SDL_DuplicateSurface'])(a0);
var _sdl3_SDL_EGL_GetCurrentConfig = Module['_sdl3_SDL_EGL_GetCurrentConfig'] = () => (_sdl3_SDL_EGL_GetCurrentConfig = Module['_sdl3_SDL_EGL_GetCurrentConfig'] = wasmExports['sdl3_SDL_EGL_GetCurrentConfig'])();
var _sdl3_SDL_EGL_GetCurrentDisplay = Module['_sdl3_SDL_EGL_GetCurrentDisplay'] = () => (_sdl3_SDL_EGL_GetCurrentDisplay = Module['_sdl3_SDL_EGL_GetCurrentDisplay'] = wasmExports['sdl3_SDL_EGL_GetCurrentDisplay'])();
var _sdl3_SDL_EGL_GetProcAddress = Module['_sdl3_SDL_EGL_GetProcAddress'] = (a0) => (_sdl3_SDL_EGL_GetProcAddress = Module['_sdl3_SDL_EGL_GetProcAddress'] = wasmExports['sdl3_SDL_EGL_GetProcAddress'])(a0);
var _sdl3_SDL_EGL_GetWindowSurface = Module['_sdl3_SDL_EGL_GetWindowSurface'] = (a0) => (_sdl3_SDL_EGL_GetWindowSurface = Module['_sdl3_SDL_EGL_GetWindowSurface'] = wasmExports['sdl3_SDL_EGL_GetWindowSurface'])(a0);
var _sdl3_SDL_EGL_SetAttributeCallbacks = Module['_sdl3_SDL_EGL_SetAttributeCallbacks'] = (a0, a1, a2, a3) => (_sdl3_SDL_EGL_SetAttributeCallbacks = Module['_sdl3_SDL_EGL_SetAttributeCallbacks'] = wasmExports['sdl3_SDL_EGL_SetAttributeCallbacks'])(a0, a1, a2, a3);
var _sdl3_SDL_EnableScreenSaver = Module['_sdl3_SDL_EnableScreenSaver'] = () => (_sdl3_SDL_EnableScreenSaver = Module['_sdl3_SDL_EnableScreenSaver'] = wasmExports['sdl3_SDL_EnableScreenSaver'])();
var _sdl3_SDL_EndGPUComputePass = Module['_sdl3_SDL_EndGPUComputePass'] = (a0) => (_sdl3_SDL_EndGPUComputePass = Module['_sdl3_SDL_EndGPUComputePass'] = wasmExports['sdl3_SDL_EndGPUComputePass'])(a0);
var _sdl3_SDL_EndGPUCopyPass = Module['_sdl3_SDL_EndGPUCopyPass'] = (a0) => (_sdl3_SDL_EndGPUCopyPass = Module['_sdl3_SDL_EndGPUCopyPass'] = wasmExports['sdl3_SDL_EndGPUCopyPass'])(a0);
var _sdl3_SDL_EndGPURenderPass = Module['_sdl3_SDL_EndGPURenderPass'] = (a0) => (_sdl3_SDL_EndGPURenderPass = Module['_sdl3_SDL_EndGPURenderPass'] = wasmExports['sdl3_SDL_EndGPURenderPass'])(a0);
var _sdl3_SDL_EnterAppMainCallbacks = Module['_sdl3_SDL_EnterAppMainCallbacks'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_EnterAppMainCallbacks = Module['_sdl3_SDL_EnterAppMainCallbacks'] = wasmExports['sdl3_SDL_EnterAppMainCallbacks'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_EnumerateDirectory = Module['_sdl3_SDL_EnumerateDirectory'] = (a0, a1, a2) => (_sdl3_SDL_EnumerateDirectory = Module['_sdl3_SDL_EnumerateDirectory'] = wasmExports['sdl3_SDL_EnumerateDirectory'])(a0, a1, a2);
var _sdl3_SDL_EnumerateProperties = Module['_sdl3_SDL_EnumerateProperties'] = (a0, a1, a2) => (_sdl3_SDL_EnumerateProperties = Module['_sdl3_SDL_EnumerateProperties'] = wasmExports['sdl3_SDL_EnumerateProperties'])(a0, a1, a2);
var _sdl3_SDL_EnumerateStorageDirectory = Module['_sdl3_SDL_EnumerateStorageDirectory'] = (a0, a1, a2, a3) => (_sdl3_SDL_EnumerateStorageDirectory = Module['_sdl3_SDL_EnumerateStorageDirectory'] = wasmExports['sdl3_SDL_EnumerateStorageDirectory'])(a0, a1, a2, a3);
var _sdl3_SDL_EventEnabled = Module['_sdl3_SDL_EventEnabled'] = (a0) => (_sdl3_SDL_EventEnabled = Module['_sdl3_SDL_EventEnabled'] = wasmExports['sdl3_SDL_EventEnabled'])(a0);
var _sdl3_SDL_FillSurfaceRect = Module['_sdl3_SDL_FillSurfaceRect'] = (a0, a1, a2) => (_sdl3_SDL_FillSurfaceRect = Module['_sdl3_SDL_FillSurfaceRect'] = wasmExports['sdl3_SDL_FillSurfaceRect'])(a0, a1, a2);
var _sdl3_SDL_FillSurfaceRects = Module['_sdl3_SDL_FillSurfaceRects'] = (a0, a1, a2, a3) => (_sdl3_SDL_FillSurfaceRects = Module['_sdl3_SDL_FillSurfaceRects'] = wasmExports['sdl3_SDL_FillSurfaceRects'])(a0, a1, a2, a3);
var _sdl3_SDL_FilterEvents = Module['_sdl3_SDL_FilterEvents'] = (a0, a1) => (_sdl3_SDL_FilterEvents = Module['_sdl3_SDL_FilterEvents'] = wasmExports['sdl3_SDL_FilterEvents'])(a0, a1);
var _sdl3_SDL_FlashWindow = Module['_sdl3_SDL_FlashWindow'] = (a0, a1) => (_sdl3_SDL_FlashWindow = Module['_sdl3_SDL_FlashWindow'] = wasmExports['sdl3_SDL_FlashWindow'])(a0, a1);
var _sdl3_SDL_FlipSurface = Module['_sdl3_SDL_FlipSurface'] = (a0, a1) => (_sdl3_SDL_FlipSurface = Module['_sdl3_SDL_FlipSurface'] = wasmExports['sdl3_SDL_FlipSurface'])(a0, a1);
var _sdl3_SDL_FlushAudioStream = Module['_sdl3_SDL_FlushAudioStream'] = (a0) => (_sdl3_SDL_FlushAudioStream = Module['_sdl3_SDL_FlushAudioStream'] = wasmExports['sdl3_SDL_FlushAudioStream'])(a0);
var _sdl3_SDL_FlushEvent = Module['_sdl3_SDL_FlushEvent'] = (a0) => (_sdl3_SDL_FlushEvent = Module['_sdl3_SDL_FlushEvent'] = wasmExports['sdl3_SDL_FlushEvent'])(a0);
var _sdl3_SDL_FlushEvents = Module['_sdl3_SDL_FlushEvents'] = (a0, a1) => (_sdl3_SDL_FlushEvents = Module['_sdl3_SDL_FlushEvents'] = wasmExports['sdl3_SDL_FlushEvents'])(a0, a1);
var _sdl3_SDL_FlushIO = Module['_sdl3_SDL_FlushIO'] = (a0) => (_sdl3_SDL_FlushIO = Module['_sdl3_SDL_FlushIO'] = wasmExports['sdl3_SDL_FlushIO'])(a0);
var _sdl3_SDL_FlushRenderer = Module['_sdl3_SDL_FlushRenderer'] = (a0) => (_sdl3_SDL_FlushRenderer = Module['_sdl3_SDL_FlushRenderer'] = wasmExports['sdl3_SDL_FlushRenderer'])(a0);
var _sdl3_SDL_GDKSuspendComplete = Module['_sdl3_SDL_GDKSuspendComplete'] = () => (_sdl3_SDL_GDKSuspendComplete = Module['_sdl3_SDL_GDKSuspendComplete'] = wasmExports['sdl3_SDL_GDKSuspendComplete'])();
var _sdl3_SDL_GL_CreateContext = Module['_sdl3_SDL_GL_CreateContext'] = (a0) => (_sdl3_SDL_GL_CreateContext = Module['_sdl3_SDL_GL_CreateContext'] = wasmExports['sdl3_SDL_GL_CreateContext'])(a0);
var _sdl3_SDL_GL_DestroyContext = Module['_sdl3_SDL_GL_DestroyContext'] = (a0) => (_sdl3_SDL_GL_DestroyContext = Module['_sdl3_SDL_GL_DestroyContext'] = wasmExports['sdl3_SDL_GL_DestroyContext'])(a0);
var _sdl3_SDL_GL_ExtensionSupported = Module['_sdl3_SDL_GL_ExtensionSupported'] = (a0) => (_sdl3_SDL_GL_ExtensionSupported = Module['_sdl3_SDL_GL_ExtensionSupported'] = wasmExports['sdl3_SDL_GL_ExtensionSupported'])(a0);
var _sdl3_SDL_GL_GetAttribute = Module['_sdl3_SDL_GL_GetAttribute'] = (a0, a1) => (_sdl3_SDL_GL_GetAttribute = Module['_sdl3_SDL_GL_GetAttribute'] = wasmExports['sdl3_SDL_GL_GetAttribute'])(a0, a1);
var _sdl3_SDL_GL_GetCurrentContext = Module['_sdl3_SDL_GL_GetCurrentContext'] = () => (_sdl3_SDL_GL_GetCurrentContext = Module['_sdl3_SDL_GL_GetCurrentContext'] = wasmExports['sdl3_SDL_GL_GetCurrentContext'])();
var _sdl3_SDL_GL_GetCurrentWindow = Module['_sdl3_SDL_GL_GetCurrentWindow'] = () => (_sdl3_SDL_GL_GetCurrentWindow = Module['_sdl3_SDL_GL_GetCurrentWindow'] = wasmExports['sdl3_SDL_GL_GetCurrentWindow'])();
var _sdl3_SDL_GL_GetProcAddress = Module['_sdl3_SDL_GL_GetProcAddress'] = (a0) => (_sdl3_SDL_GL_GetProcAddress = Module['_sdl3_SDL_GL_GetProcAddress'] = wasmExports['sdl3_SDL_GL_GetProcAddress'])(a0);
var _sdl3_SDL_GL_GetSwapInterval = Module['_sdl3_SDL_GL_GetSwapInterval'] = (a0) => (_sdl3_SDL_GL_GetSwapInterval = Module['_sdl3_SDL_GL_GetSwapInterval'] = wasmExports['sdl3_SDL_GL_GetSwapInterval'])(a0);
var _sdl3_SDL_GL_LoadLibrary = Module['_sdl3_SDL_GL_LoadLibrary'] = (a0) => (_sdl3_SDL_GL_LoadLibrary = Module['_sdl3_SDL_GL_LoadLibrary'] = wasmExports['sdl3_SDL_GL_LoadLibrary'])(a0);
var _sdl3_SDL_GL_MakeCurrent = Module['_sdl3_SDL_GL_MakeCurrent'] = (a0, a1) => (_sdl3_SDL_GL_MakeCurrent = Module['_sdl3_SDL_GL_MakeCurrent'] = wasmExports['sdl3_SDL_GL_MakeCurrent'])(a0, a1);
var _sdl3_SDL_GL_ResetAttributes = Module['_sdl3_SDL_GL_ResetAttributes'] = () => (_sdl3_SDL_GL_ResetAttributes = Module['_sdl3_SDL_GL_ResetAttributes'] = wasmExports['sdl3_SDL_GL_ResetAttributes'])();
var _sdl3_SDL_GL_SetAttribute = Module['_sdl3_SDL_GL_SetAttribute'] = (a0, a1) => (_sdl3_SDL_GL_SetAttribute = Module['_sdl3_SDL_GL_SetAttribute'] = wasmExports['sdl3_SDL_GL_SetAttribute'])(a0, a1);
var _sdl3_SDL_GL_SetSwapInterval = Module['_sdl3_SDL_GL_SetSwapInterval'] = (a0) => (_sdl3_SDL_GL_SetSwapInterval = Module['_sdl3_SDL_GL_SetSwapInterval'] = wasmExports['sdl3_SDL_GL_SetSwapInterval'])(a0);
var _sdl3_SDL_GL_SwapWindow = Module['_sdl3_SDL_GL_SwapWindow'] = (a0) => (_sdl3_SDL_GL_SwapWindow = Module['_sdl3_SDL_GL_SwapWindow'] = wasmExports['sdl3_SDL_GL_SwapWindow'])(a0);
var _sdl3_SDL_GL_UnloadLibrary = Module['_sdl3_SDL_GL_UnloadLibrary'] = () => (_sdl3_SDL_GL_UnloadLibrary = Module['_sdl3_SDL_GL_UnloadLibrary'] = wasmExports['sdl3_SDL_GL_UnloadLibrary'])();
var _sdl3_SDL_GPUSupportsProperties = Module['_sdl3_SDL_GPUSupportsProperties'] = (a0) => (_sdl3_SDL_GPUSupportsProperties = Module['_sdl3_SDL_GPUSupportsProperties'] = wasmExports['sdl3_SDL_GPUSupportsProperties'])(a0);
var _sdl3_SDL_GPUSupportsShaderFormats = Module['_sdl3_SDL_GPUSupportsShaderFormats'] = (a0, a1) => (_sdl3_SDL_GPUSupportsShaderFormats = Module['_sdl3_SDL_GPUSupportsShaderFormats'] = wasmExports['sdl3_SDL_GPUSupportsShaderFormats'])(a0, a1);
var _sdl3_SDL_GPUTextureFormatTexelBlockSize = Module['_sdl3_SDL_GPUTextureFormatTexelBlockSize'] = (a0) => (_sdl3_SDL_GPUTextureFormatTexelBlockSize = Module['_sdl3_SDL_GPUTextureFormatTexelBlockSize'] = wasmExports['sdl3_SDL_GPUTextureFormatTexelBlockSize'])(a0);
var _sdl3_SDL_GPUTextureSupportsFormat = Module['_sdl3_SDL_GPUTextureSupportsFormat'] = (a0, a1, a2, a3) => (_sdl3_SDL_GPUTextureSupportsFormat = Module['_sdl3_SDL_GPUTextureSupportsFormat'] = wasmExports['sdl3_SDL_GPUTextureSupportsFormat'])(a0, a1, a2, a3);
var _sdl3_SDL_GPUTextureSupportsSampleCount = Module['_sdl3_SDL_GPUTextureSupportsSampleCount'] = (a0, a1, a2) => (_sdl3_SDL_GPUTextureSupportsSampleCount = Module['_sdl3_SDL_GPUTextureSupportsSampleCount'] = wasmExports['sdl3_SDL_GPUTextureSupportsSampleCount'])(a0, a1, a2);
var _sdl3_SDL_GUIDToString = Module['_sdl3_SDL_GUIDToString'] = (a0, a1, a2) => (_sdl3_SDL_GUIDToString = Module['_sdl3_SDL_GUIDToString'] = wasmExports['sdl3_SDL_GUIDToString'])(a0, a1, a2);
var _sdl3_SDL_GamepadConnected = Module['_sdl3_SDL_GamepadConnected'] = (a0) => (_sdl3_SDL_GamepadConnected = Module['_sdl3_SDL_GamepadConnected'] = wasmExports['sdl3_SDL_GamepadConnected'])(a0);
var _sdl3_SDL_GamepadEventsEnabled = Module['_sdl3_SDL_GamepadEventsEnabled'] = () => (_sdl3_SDL_GamepadEventsEnabled = Module['_sdl3_SDL_GamepadEventsEnabled'] = wasmExports['sdl3_SDL_GamepadEventsEnabled'])();
var _sdl3_SDL_GamepadHasAxis = Module['_sdl3_SDL_GamepadHasAxis'] = (a0, a1) => (_sdl3_SDL_GamepadHasAxis = Module['_sdl3_SDL_GamepadHasAxis'] = wasmExports['sdl3_SDL_GamepadHasAxis'])(a0, a1);
var _sdl3_SDL_GamepadHasButton = Module['_sdl3_SDL_GamepadHasButton'] = (a0, a1) => (_sdl3_SDL_GamepadHasButton = Module['_sdl3_SDL_GamepadHasButton'] = wasmExports['sdl3_SDL_GamepadHasButton'])(a0, a1);
var _sdl3_SDL_GamepadHasSensor = Module['_sdl3_SDL_GamepadHasSensor'] = (a0, a1) => (_sdl3_SDL_GamepadHasSensor = Module['_sdl3_SDL_GamepadHasSensor'] = wasmExports['sdl3_SDL_GamepadHasSensor'])(a0, a1);
var _sdl3_SDL_GamepadSensorEnabled = Module['_sdl3_SDL_GamepadSensorEnabled'] = (a0, a1) => (_sdl3_SDL_GamepadSensorEnabled = Module['_sdl3_SDL_GamepadSensorEnabled'] = wasmExports['sdl3_SDL_GamepadSensorEnabled'])(a0, a1);
var _sdl3_SDL_GenerateMipmapsForGPUTexture = Module['_sdl3_SDL_GenerateMipmapsForGPUTexture'] = (a0, a1) => (_sdl3_SDL_GenerateMipmapsForGPUTexture = Module['_sdl3_SDL_GenerateMipmapsForGPUTexture'] = wasmExports['sdl3_SDL_GenerateMipmapsForGPUTexture'])(a0, a1);
var _sdl3_SDL_GetAppMetadataProperty = Module['_sdl3_SDL_GetAppMetadataProperty'] = (a0) => (_sdl3_SDL_GetAppMetadataProperty = Module['_sdl3_SDL_GetAppMetadataProperty'] = wasmExports['sdl3_SDL_GetAppMetadataProperty'])(a0);
var _sdl3_SDL_GetAssertionHandler = Module['_sdl3_SDL_GetAssertionHandler'] = (a0) => (_sdl3_SDL_GetAssertionHandler = Module['_sdl3_SDL_GetAssertionHandler'] = wasmExports['sdl3_SDL_GetAssertionHandler'])(a0);
var _sdl3_SDL_GetAssertionReport = Module['_sdl3_SDL_GetAssertionReport'] = () => (_sdl3_SDL_GetAssertionReport = Module['_sdl3_SDL_GetAssertionReport'] = wasmExports['sdl3_SDL_GetAssertionReport'])();
var _sdl3_SDL_GetAsyncIOResult = Module['_sdl3_SDL_GetAsyncIOResult'] = (a0, a1) => (_sdl3_SDL_GetAsyncIOResult = Module['_sdl3_SDL_GetAsyncIOResult'] = wasmExports['sdl3_SDL_GetAsyncIOResult'])(a0, a1);
var _sdl3_SDL_GetAsyncIOSize = Module['_sdl3_SDL_GetAsyncIOSize'] = (a0) => (_sdl3_SDL_GetAsyncIOSize = Module['_sdl3_SDL_GetAsyncIOSize'] = wasmExports['sdl3_SDL_GetAsyncIOSize'])(a0);
var _sdl3_SDL_GetAtomicInt = Module['_sdl3_SDL_GetAtomicInt'] = (a0) => (_sdl3_SDL_GetAtomicInt = Module['_sdl3_SDL_GetAtomicInt'] = wasmExports['sdl3_SDL_GetAtomicInt'])(a0);
var _sdl3_SDL_GetAtomicPointer = Module['_sdl3_SDL_GetAtomicPointer'] = (a0) => (_sdl3_SDL_GetAtomicPointer = Module['_sdl3_SDL_GetAtomicPointer'] = wasmExports['sdl3_SDL_GetAtomicPointer'])(a0);
var _sdl3_SDL_GetAtomicU32 = Module['_sdl3_SDL_GetAtomicU32'] = (a0) => (_sdl3_SDL_GetAtomicU32 = Module['_sdl3_SDL_GetAtomicU32'] = wasmExports['sdl3_SDL_GetAtomicU32'])(a0);
var _sdl3_SDL_GetAudioDeviceChannelMap = Module['_sdl3_SDL_GetAudioDeviceChannelMap'] = (a0, a1) => (_sdl3_SDL_GetAudioDeviceChannelMap = Module['_sdl3_SDL_GetAudioDeviceChannelMap'] = wasmExports['sdl3_SDL_GetAudioDeviceChannelMap'])(a0, a1);
var _sdl3_SDL_GetAudioDeviceFormat = Module['_sdl3_SDL_GetAudioDeviceFormat'] = (a0, a1, a2) => (_sdl3_SDL_GetAudioDeviceFormat = Module['_sdl3_SDL_GetAudioDeviceFormat'] = wasmExports['sdl3_SDL_GetAudioDeviceFormat'])(a0, a1, a2);
var _sdl3_SDL_GetAudioDeviceGain = Module['_sdl3_SDL_GetAudioDeviceGain'] = (a0) => (_sdl3_SDL_GetAudioDeviceGain = Module['_sdl3_SDL_GetAudioDeviceGain'] = wasmExports['sdl3_SDL_GetAudioDeviceGain'])(a0);
var _sdl3_SDL_GetAudioDeviceName = Module['_sdl3_SDL_GetAudioDeviceName'] = (a0) => (_sdl3_SDL_GetAudioDeviceName = Module['_sdl3_SDL_GetAudioDeviceName'] = wasmExports['sdl3_SDL_GetAudioDeviceName'])(a0);
var _sdl3_SDL_GetAudioDriver = Module['_sdl3_SDL_GetAudioDriver'] = (a0) => (_sdl3_SDL_GetAudioDriver = Module['_sdl3_SDL_GetAudioDriver'] = wasmExports['sdl3_SDL_GetAudioDriver'])(a0);
var _sdl3_SDL_GetAudioFormatName = Module['_sdl3_SDL_GetAudioFormatName'] = (a0) => (_sdl3_SDL_GetAudioFormatName = Module['_sdl3_SDL_GetAudioFormatName'] = wasmExports['sdl3_SDL_GetAudioFormatName'])(a0);
var _sdl3_SDL_GetAudioPlaybackDevices = Module['_sdl3_SDL_GetAudioPlaybackDevices'] = (a0) => (_sdl3_SDL_GetAudioPlaybackDevices = Module['_sdl3_SDL_GetAudioPlaybackDevices'] = wasmExports['sdl3_SDL_GetAudioPlaybackDevices'])(a0);
var _sdl3_SDL_GetAudioRecordingDevices = Module['_sdl3_SDL_GetAudioRecordingDevices'] = (a0) => (_sdl3_SDL_GetAudioRecordingDevices = Module['_sdl3_SDL_GetAudioRecordingDevices'] = wasmExports['sdl3_SDL_GetAudioRecordingDevices'])(a0);
var _sdl3_SDL_GetAudioStreamAvailable = Module['_sdl3_SDL_GetAudioStreamAvailable'] = (a0) => (_sdl3_SDL_GetAudioStreamAvailable = Module['_sdl3_SDL_GetAudioStreamAvailable'] = wasmExports['sdl3_SDL_GetAudioStreamAvailable'])(a0);
var _sdl3_SDL_GetAudioStreamData = Module['_sdl3_SDL_GetAudioStreamData'] = (a0, a1, a2) => (_sdl3_SDL_GetAudioStreamData = Module['_sdl3_SDL_GetAudioStreamData'] = wasmExports['sdl3_SDL_GetAudioStreamData'])(a0, a1, a2);
var _sdl3_SDL_GetAudioStreamDevice = Module['_sdl3_SDL_GetAudioStreamDevice'] = (a0) => (_sdl3_SDL_GetAudioStreamDevice = Module['_sdl3_SDL_GetAudioStreamDevice'] = wasmExports['sdl3_SDL_GetAudioStreamDevice'])(a0);
var _sdl3_SDL_GetAudioStreamFormat = Module['_sdl3_SDL_GetAudioStreamFormat'] = (a0, a1, a2) => (_sdl3_SDL_GetAudioStreamFormat = Module['_sdl3_SDL_GetAudioStreamFormat'] = wasmExports['sdl3_SDL_GetAudioStreamFormat'])(a0, a1, a2);
var _sdl3_SDL_GetAudioStreamFrequencyRatio = Module['_sdl3_SDL_GetAudioStreamFrequencyRatio'] = (a0) => (_sdl3_SDL_GetAudioStreamFrequencyRatio = Module['_sdl3_SDL_GetAudioStreamFrequencyRatio'] = wasmExports['sdl3_SDL_GetAudioStreamFrequencyRatio'])(a0);
var _sdl3_SDL_GetAudioStreamGain = Module['_sdl3_SDL_GetAudioStreamGain'] = (a0) => (_sdl3_SDL_GetAudioStreamGain = Module['_sdl3_SDL_GetAudioStreamGain'] = wasmExports['sdl3_SDL_GetAudioStreamGain'])(a0);
var _sdl3_SDL_GetAudioStreamInputChannelMap = Module['_sdl3_SDL_GetAudioStreamInputChannelMap'] = (a0, a1) => (_sdl3_SDL_GetAudioStreamInputChannelMap = Module['_sdl3_SDL_GetAudioStreamInputChannelMap'] = wasmExports['sdl3_SDL_GetAudioStreamInputChannelMap'])(a0, a1);
var _sdl3_SDL_GetAudioStreamOutputChannelMap = Module['_sdl3_SDL_GetAudioStreamOutputChannelMap'] = (a0, a1) => (_sdl3_SDL_GetAudioStreamOutputChannelMap = Module['_sdl3_SDL_GetAudioStreamOutputChannelMap'] = wasmExports['sdl3_SDL_GetAudioStreamOutputChannelMap'])(a0, a1);
var _sdl3_SDL_GetAudioStreamProperties = Module['_sdl3_SDL_GetAudioStreamProperties'] = (a0) => (_sdl3_SDL_GetAudioStreamProperties = Module['_sdl3_SDL_GetAudioStreamProperties'] = wasmExports['sdl3_SDL_GetAudioStreamProperties'])(a0);
var _sdl3_SDL_GetAudioStreamQueued = Module['_sdl3_SDL_GetAudioStreamQueued'] = (a0) => (_sdl3_SDL_GetAudioStreamQueued = Module['_sdl3_SDL_GetAudioStreamQueued'] = wasmExports['sdl3_SDL_GetAudioStreamQueued'])(a0);
var _sdl3_SDL_GetBasePath = Module['_sdl3_SDL_GetBasePath'] = () => (_sdl3_SDL_GetBasePath = Module['_sdl3_SDL_GetBasePath'] = wasmExports['sdl3_SDL_GetBasePath'])();
var _sdl3_SDL_GetBooleanProperty = Module['_sdl3_SDL_GetBooleanProperty'] = (a0, a1, a2) => (_sdl3_SDL_GetBooleanProperty = Module['_sdl3_SDL_GetBooleanProperty'] = wasmExports['sdl3_SDL_GetBooleanProperty'])(a0, a1, a2);
var _sdl3_SDL_GetCPUCacheLineSize = Module['_sdl3_SDL_GetCPUCacheLineSize'] = () => (_sdl3_SDL_GetCPUCacheLineSize = Module['_sdl3_SDL_GetCPUCacheLineSize'] = wasmExports['sdl3_SDL_GetCPUCacheLineSize'])();
var _sdl3_SDL_GetCameraDriver = Module['_sdl3_SDL_GetCameraDriver'] = (a0) => (_sdl3_SDL_GetCameraDriver = Module['_sdl3_SDL_GetCameraDriver'] = wasmExports['sdl3_SDL_GetCameraDriver'])(a0);
var _sdl3_SDL_GetCameraFormat = Module['_sdl3_SDL_GetCameraFormat'] = (a0, a1) => (_sdl3_SDL_GetCameraFormat = Module['_sdl3_SDL_GetCameraFormat'] = wasmExports['sdl3_SDL_GetCameraFormat'])(a0, a1);
var _sdl3_SDL_GetCameraID = Module['_sdl3_SDL_GetCameraID'] = (a0) => (_sdl3_SDL_GetCameraID = Module['_sdl3_SDL_GetCameraID'] = wasmExports['sdl3_SDL_GetCameraID'])(a0);
var _sdl3_SDL_GetCameraName = Module['_sdl3_SDL_GetCameraName'] = (a0) => (_sdl3_SDL_GetCameraName = Module['_sdl3_SDL_GetCameraName'] = wasmExports['sdl3_SDL_GetCameraName'])(a0);
var _sdl3_SDL_GetCameraPermissionState = Module['_sdl3_SDL_GetCameraPermissionState'] = (a0) => (_sdl3_SDL_GetCameraPermissionState = Module['_sdl3_SDL_GetCameraPermissionState'] = wasmExports['sdl3_SDL_GetCameraPermissionState'])(a0);
var _sdl3_SDL_GetCameraPosition = Module['_sdl3_SDL_GetCameraPosition'] = (a0) => (_sdl3_SDL_GetCameraPosition = Module['_sdl3_SDL_GetCameraPosition'] = wasmExports['sdl3_SDL_GetCameraPosition'])(a0);
var _sdl3_SDL_GetCameraProperties = Module['_sdl3_SDL_GetCameraProperties'] = (a0) => (_sdl3_SDL_GetCameraProperties = Module['_sdl3_SDL_GetCameraProperties'] = wasmExports['sdl3_SDL_GetCameraProperties'])(a0);
var _sdl3_SDL_GetCameraSupportedFormats = Module['_sdl3_SDL_GetCameraSupportedFormats'] = (a0, a1) => (_sdl3_SDL_GetCameraSupportedFormats = Module['_sdl3_SDL_GetCameraSupportedFormats'] = wasmExports['sdl3_SDL_GetCameraSupportedFormats'])(a0, a1);
var _sdl3_SDL_GetCameras = Module['_sdl3_SDL_GetCameras'] = (a0) => (_sdl3_SDL_GetCameras = Module['_sdl3_SDL_GetCameras'] = wasmExports['sdl3_SDL_GetCameras'])(a0);
var _sdl3_SDL_GetClipboardData = Module['_sdl3_SDL_GetClipboardData'] = (a0, a1) => (_sdl3_SDL_GetClipboardData = Module['_sdl3_SDL_GetClipboardData'] = wasmExports['sdl3_SDL_GetClipboardData'])(a0, a1);
var _sdl3_SDL_GetClipboardMimeTypes = Module['_sdl3_SDL_GetClipboardMimeTypes'] = (a0) => (_sdl3_SDL_GetClipboardMimeTypes = Module['_sdl3_SDL_GetClipboardMimeTypes'] = wasmExports['sdl3_SDL_GetClipboardMimeTypes'])(a0);
var _sdl3_SDL_GetClipboardText = Module['_sdl3_SDL_GetClipboardText'] = () => (_sdl3_SDL_GetClipboardText = Module['_sdl3_SDL_GetClipboardText'] = wasmExports['sdl3_SDL_GetClipboardText'])();
var _sdl3_SDL_GetClosestFullscreenDisplayMode = Module['_sdl3_SDL_GetClosestFullscreenDisplayMode'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_GetClosestFullscreenDisplayMode = Module['_sdl3_SDL_GetClosestFullscreenDisplayMode'] = wasmExports['sdl3_SDL_GetClosestFullscreenDisplayMode'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_GetCurrentAudioDriver = Module['_sdl3_SDL_GetCurrentAudioDriver'] = () => (_sdl3_SDL_GetCurrentAudioDriver = Module['_sdl3_SDL_GetCurrentAudioDriver'] = wasmExports['sdl3_SDL_GetCurrentAudioDriver'])();
var _sdl3_SDL_GetCurrentCameraDriver = Module['_sdl3_SDL_GetCurrentCameraDriver'] = () => (_sdl3_SDL_GetCurrentCameraDriver = Module['_sdl3_SDL_GetCurrentCameraDriver'] = wasmExports['sdl3_SDL_GetCurrentCameraDriver'])();
var _sdl3_SDL_GetCurrentDirectory = Module['_sdl3_SDL_GetCurrentDirectory'] = () => (_sdl3_SDL_GetCurrentDirectory = Module['_sdl3_SDL_GetCurrentDirectory'] = wasmExports['sdl3_SDL_GetCurrentDirectory'])();
var _sdl3_SDL_GetCurrentDisplayMode = Module['_sdl3_SDL_GetCurrentDisplayMode'] = (a0) => (_sdl3_SDL_GetCurrentDisplayMode = Module['_sdl3_SDL_GetCurrentDisplayMode'] = wasmExports['sdl3_SDL_GetCurrentDisplayMode'])(a0);
var _sdl3_SDL_GetCurrentDisplayOrientation = Module['_sdl3_SDL_GetCurrentDisplayOrientation'] = (a0) => (_sdl3_SDL_GetCurrentDisplayOrientation = Module['_sdl3_SDL_GetCurrentDisplayOrientation'] = wasmExports['sdl3_SDL_GetCurrentDisplayOrientation'])(a0);
var _sdl3_SDL_GetCurrentRenderOutputSize = Module['_sdl3_SDL_GetCurrentRenderOutputSize'] = (a0, a1, a2) => (_sdl3_SDL_GetCurrentRenderOutputSize = Module['_sdl3_SDL_GetCurrentRenderOutputSize'] = wasmExports['sdl3_SDL_GetCurrentRenderOutputSize'])(a0, a1, a2);
var _sdl3_SDL_GetCurrentThreadID = Module['_sdl3_SDL_GetCurrentThreadID'] = () => (_sdl3_SDL_GetCurrentThreadID = Module['_sdl3_SDL_GetCurrentThreadID'] = wasmExports['sdl3_SDL_GetCurrentThreadID'])();
var _sdl3_SDL_GetCurrentTime = Module['_sdl3_SDL_GetCurrentTime'] = (a0) => (_sdl3_SDL_GetCurrentTime = Module['_sdl3_SDL_GetCurrentTime'] = wasmExports['sdl3_SDL_GetCurrentTime'])(a0);
var _sdl3_SDL_GetCurrentVideoDriver = Module['_sdl3_SDL_GetCurrentVideoDriver'] = () => (_sdl3_SDL_GetCurrentVideoDriver = Module['_sdl3_SDL_GetCurrentVideoDriver'] = wasmExports['sdl3_SDL_GetCurrentVideoDriver'])();
var _sdl3_SDL_GetCursor = Module['_sdl3_SDL_GetCursor'] = () => (_sdl3_SDL_GetCursor = Module['_sdl3_SDL_GetCursor'] = wasmExports['sdl3_SDL_GetCursor'])();
var _sdl3_SDL_GetDateTimeLocalePreferences = Module['_sdl3_SDL_GetDateTimeLocalePreferences'] = (a0, a1) => (_sdl3_SDL_GetDateTimeLocalePreferences = Module['_sdl3_SDL_GetDateTimeLocalePreferences'] = wasmExports['sdl3_SDL_GetDateTimeLocalePreferences'])(a0, a1);
var _sdl3_SDL_GetDayOfWeek = Module['_sdl3_SDL_GetDayOfWeek'] = (a0, a1, a2) => (_sdl3_SDL_GetDayOfWeek = Module['_sdl3_SDL_GetDayOfWeek'] = wasmExports['sdl3_SDL_GetDayOfWeek'])(a0, a1, a2);
var _sdl3_SDL_GetDayOfYear = Module['_sdl3_SDL_GetDayOfYear'] = (a0, a1, a2) => (_sdl3_SDL_GetDayOfYear = Module['_sdl3_SDL_GetDayOfYear'] = wasmExports['sdl3_SDL_GetDayOfYear'])(a0, a1, a2);
var _sdl3_SDL_GetDaysInMonth = Module['_sdl3_SDL_GetDaysInMonth'] = (a0, a1) => (_sdl3_SDL_GetDaysInMonth = Module['_sdl3_SDL_GetDaysInMonth'] = wasmExports['sdl3_SDL_GetDaysInMonth'])(a0, a1);
var _sdl3_SDL_GetDefaultAssertionHandler = Module['_sdl3_SDL_GetDefaultAssertionHandler'] = () => (_sdl3_SDL_GetDefaultAssertionHandler = Module['_sdl3_SDL_GetDefaultAssertionHandler'] = wasmExports['sdl3_SDL_GetDefaultAssertionHandler'])();
var _sdl3_SDL_GetDefaultCursor = Module['_sdl3_SDL_GetDefaultCursor'] = () => (_sdl3_SDL_GetDefaultCursor = Module['_sdl3_SDL_GetDefaultCursor'] = wasmExports['sdl3_SDL_GetDefaultCursor'])();
var _sdl3_SDL_GetDefaultLogOutputFunction = Module['_sdl3_SDL_GetDefaultLogOutputFunction'] = () => (_sdl3_SDL_GetDefaultLogOutputFunction = Module['_sdl3_SDL_GetDefaultLogOutputFunction'] = wasmExports['sdl3_SDL_GetDefaultLogOutputFunction'])();
var _sdl3_SDL_GetDesktopDisplayMode = Module['_sdl3_SDL_GetDesktopDisplayMode'] = (a0) => (_sdl3_SDL_GetDesktopDisplayMode = Module['_sdl3_SDL_GetDesktopDisplayMode'] = wasmExports['sdl3_SDL_GetDesktopDisplayMode'])(a0);
var _sdl3_SDL_GetDisplayBounds = Module['_sdl3_SDL_GetDisplayBounds'] = (a0, a1) => (_sdl3_SDL_GetDisplayBounds = Module['_sdl3_SDL_GetDisplayBounds'] = wasmExports['sdl3_SDL_GetDisplayBounds'])(a0, a1);
var _sdl3_SDL_GetDisplayContentScale = Module['_sdl3_SDL_GetDisplayContentScale'] = (a0) => (_sdl3_SDL_GetDisplayContentScale = Module['_sdl3_SDL_GetDisplayContentScale'] = wasmExports['sdl3_SDL_GetDisplayContentScale'])(a0);
var _sdl3_SDL_GetDisplayForPoint = Module['_sdl3_SDL_GetDisplayForPoint'] = (a0) => (_sdl3_SDL_GetDisplayForPoint = Module['_sdl3_SDL_GetDisplayForPoint'] = wasmExports['sdl3_SDL_GetDisplayForPoint'])(a0);
var _sdl3_SDL_GetDisplayForRect = Module['_sdl3_SDL_GetDisplayForRect'] = (a0) => (_sdl3_SDL_GetDisplayForRect = Module['_sdl3_SDL_GetDisplayForRect'] = wasmExports['sdl3_SDL_GetDisplayForRect'])(a0);
var _sdl3_SDL_GetDisplayForWindow = Module['_sdl3_SDL_GetDisplayForWindow'] = (a0) => (_sdl3_SDL_GetDisplayForWindow = Module['_sdl3_SDL_GetDisplayForWindow'] = wasmExports['sdl3_SDL_GetDisplayForWindow'])(a0);
var _sdl3_SDL_GetDisplayName = Module['_sdl3_SDL_GetDisplayName'] = (a0) => (_sdl3_SDL_GetDisplayName = Module['_sdl3_SDL_GetDisplayName'] = wasmExports['sdl3_SDL_GetDisplayName'])(a0);
var _sdl3_SDL_GetDisplayProperties = Module['_sdl3_SDL_GetDisplayProperties'] = (a0) => (_sdl3_SDL_GetDisplayProperties = Module['_sdl3_SDL_GetDisplayProperties'] = wasmExports['sdl3_SDL_GetDisplayProperties'])(a0);
var _sdl3_SDL_GetDisplayUsableBounds = Module['_sdl3_SDL_GetDisplayUsableBounds'] = (a0, a1) => (_sdl3_SDL_GetDisplayUsableBounds = Module['_sdl3_SDL_GetDisplayUsableBounds'] = wasmExports['sdl3_SDL_GetDisplayUsableBounds'])(a0, a1);
var _sdl3_SDL_GetDisplays = Module['_sdl3_SDL_GetDisplays'] = (a0) => (_sdl3_SDL_GetDisplays = Module['_sdl3_SDL_GetDisplays'] = wasmExports['sdl3_SDL_GetDisplays'])(a0);
var _sdl3_SDL_GetError = Module['_sdl3_SDL_GetError'] = () => (_sdl3_SDL_GetError = Module['_sdl3_SDL_GetError'] = wasmExports['sdl3_SDL_GetError'])();
var _sdl3_SDL_GetEventFilter = Module['_sdl3_SDL_GetEventFilter'] = (a0, a1) => (_sdl3_SDL_GetEventFilter = Module['_sdl3_SDL_GetEventFilter'] = wasmExports['sdl3_SDL_GetEventFilter'])(a0, a1);
var _sdl3_SDL_GetFloatProperty = Module['_sdl3_SDL_GetFloatProperty'] = (a0, a1, a2) => (_sdl3_SDL_GetFloatProperty = Module['_sdl3_SDL_GetFloatProperty'] = wasmExports['sdl3_SDL_GetFloatProperty'])(a0, a1, a2);
var _sdl3_SDL_GetFullscreenDisplayModes = Module['_sdl3_SDL_GetFullscreenDisplayModes'] = (a0, a1) => (_sdl3_SDL_GetFullscreenDisplayModes = Module['_sdl3_SDL_GetFullscreenDisplayModes'] = wasmExports['sdl3_SDL_GetFullscreenDisplayModes'])(a0, a1);
var _sdl3_SDL_GetGPUDeviceDriver = Module['_sdl3_SDL_GetGPUDeviceDriver'] = (a0) => (_sdl3_SDL_GetGPUDeviceDriver = Module['_sdl3_SDL_GetGPUDeviceDriver'] = wasmExports['sdl3_SDL_GetGPUDeviceDriver'])(a0);
var _sdl3_SDL_GetGPUDriver = Module['_sdl3_SDL_GetGPUDriver'] = (a0) => (_sdl3_SDL_GetGPUDriver = Module['_sdl3_SDL_GetGPUDriver'] = wasmExports['sdl3_SDL_GetGPUDriver'])(a0);
var _sdl3_SDL_GetGPUShaderFormats = Module['_sdl3_SDL_GetGPUShaderFormats'] = (a0) => (_sdl3_SDL_GetGPUShaderFormats = Module['_sdl3_SDL_GetGPUShaderFormats'] = wasmExports['sdl3_SDL_GetGPUShaderFormats'])(a0);
var _sdl3_SDL_GetGPUSwapchainTextureFormat = Module['_sdl3_SDL_GetGPUSwapchainTextureFormat'] = (a0, a1) => (_sdl3_SDL_GetGPUSwapchainTextureFormat = Module['_sdl3_SDL_GetGPUSwapchainTextureFormat'] = wasmExports['sdl3_SDL_GetGPUSwapchainTextureFormat'])(a0, a1);
var _sdl3_SDL_GetGamepadAppleSFSymbolsNameForAxis = Module['_sdl3_SDL_GetGamepadAppleSFSymbolsNameForAxis'] = (a0, a1) => (_sdl3_SDL_GetGamepadAppleSFSymbolsNameForAxis = Module['_sdl3_SDL_GetGamepadAppleSFSymbolsNameForAxis'] = wasmExports['sdl3_SDL_GetGamepadAppleSFSymbolsNameForAxis'])(a0, a1);
var _sdl3_SDL_GetGamepadAppleSFSymbolsNameForButton = Module['_sdl3_SDL_GetGamepadAppleSFSymbolsNameForButton'] = (a0, a1) => (_sdl3_SDL_GetGamepadAppleSFSymbolsNameForButton = Module['_sdl3_SDL_GetGamepadAppleSFSymbolsNameForButton'] = wasmExports['sdl3_SDL_GetGamepadAppleSFSymbolsNameForButton'])(a0, a1);
var _sdl3_SDL_GetGamepadAxis = Module['_sdl3_SDL_GetGamepadAxis'] = (a0, a1) => (_sdl3_SDL_GetGamepadAxis = Module['_sdl3_SDL_GetGamepadAxis'] = wasmExports['sdl3_SDL_GetGamepadAxis'])(a0, a1);
var _sdl3_SDL_GetGamepadAxisFromString = Module['_sdl3_SDL_GetGamepadAxisFromString'] = (a0) => (_sdl3_SDL_GetGamepadAxisFromString = Module['_sdl3_SDL_GetGamepadAxisFromString'] = wasmExports['sdl3_SDL_GetGamepadAxisFromString'])(a0);
var _sdl3_SDL_GetGamepadBindings = Module['_sdl3_SDL_GetGamepadBindings'] = (a0, a1) => (_sdl3_SDL_GetGamepadBindings = Module['_sdl3_SDL_GetGamepadBindings'] = wasmExports['sdl3_SDL_GetGamepadBindings'])(a0, a1);
var _sdl3_SDL_GetGamepadButton = Module['_sdl3_SDL_GetGamepadButton'] = (a0, a1) => (_sdl3_SDL_GetGamepadButton = Module['_sdl3_SDL_GetGamepadButton'] = wasmExports['sdl3_SDL_GetGamepadButton'])(a0, a1);
var _sdl3_SDL_GetGamepadButtonFromString = Module['_sdl3_SDL_GetGamepadButtonFromString'] = (a0) => (_sdl3_SDL_GetGamepadButtonFromString = Module['_sdl3_SDL_GetGamepadButtonFromString'] = wasmExports['sdl3_SDL_GetGamepadButtonFromString'])(a0);
var _sdl3_SDL_GetGamepadButtonLabel = Module['_sdl3_SDL_GetGamepadButtonLabel'] = (a0, a1) => (_sdl3_SDL_GetGamepadButtonLabel = Module['_sdl3_SDL_GetGamepadButtonLabel'] = wasmExports['sdl3_SDL_GetGamepadButtonLabel'])(a0, a1);
var _sdl3_SDL_GetGamepadButtonLabelForType = Module['_sdl3_SDL_GetGamepadButtonLabelForType'] = (a0, a1) => (_sdl3_SDL_GetGamepadButtonLabelForType = Module['_sdl3_SDL_GetGamepadButtonLabelForType'] = wasmExports['sdl3_SDL_GetGamepadButtonLabelForType'])(a0, a1);
var _sdl3_SDL_GetGamepadConnectionState = Module['_sdl3_SDL_GetGamepadConnectionState'] = (a0) => (_sdl3_SDL_GetGamepadConnectionState = Module['_sdl3_SDL_GetGamepadConnectionState'] = wasmExports['sdl3_SDL_GetGamepadConnectionState'])(a0);
var _sdl3_SDL_GetGamepadFirmwareVersion = Module['_sdl3_SDL_GetGamepadFirmwareVersion'] = (a0) => (_sdl3_SDL_GetGamepadFirmwareVersion = Module['_sdl3_SDL_GetGamepadFirmwareVersion'] = wasmExports['sdl3_SDL_GetGamepadFirmwareVersion'])(a0);
var _sdl3_SDL_GetGamepadFromID = Module['_sdl3_SDL_GetGamepadFromID'] = (a0) => (_sdl3_SDL_GetGamepadFromID = Module['_sdl3_SDL_GetGamepadFromID'] = wasmExports['sdl3_SDL_GetGamepadFromID'])(a0);
var _sdl3_SDL_GetGamepadFromPlayerIndex = Module['_sdl3_SDL_GetGamepadFromPlayerIndex'] = (a0) => (_sdl3_SDL_GetGamepadFromPlayerIndex = Module['_sdl3_SDL_GetGamepadFromPlayerIndex'] = wasmExports['sdl3_SDL_GetGamepadFromPlayerIndex'])(a0);
var _sdl3_SDL_GetGamepadGUIDForID = Module['_sdl3_SDL_GetGamepadGUIDForID'] = (a0) => (_sdl3_SDL_GetGamepadGUIDForID = Module['_sdl3_SDL_GetGamepadGUIDForID'] = wasmExports['sdl3_SDL_GetGamepadGUIDForID'])(a0);
var _sdl3_SDL_GetGamepadID = Module['_sdl3_SDL_GetGamepadID'] = (a0) => (_sdl3_SDL_GetGamepadID = Module['_sdl3_SDL_GetGamepadID'] = wasmExports['sdl3_SDL_GetGamepadID'])(a0);
var _sdl3_SDL_GetGamepadJoystick = Module['_sdl3_SDL_GetGamepadJoystick'] = (a0) => (_sdl3_SDL_GetGamepadJoystick = Module['_sdl3_SDL_GetGamepadJoystick'] = wasmExports['sdl3_SDL_GetGamepadJoystick'])(a0);
var _sdl3_SDL_GetGamepadMapping = Module['_sdl3_SDL_GetGamepadMapping'] = (a0) => (_sdl3_SDL_GetGamepadMapping = Module['_sdl3_SDL_GetGamepadMapping'] = wasmExports['sdl3_SDL_GetGamepadMapping'])(a0);
var _sdl3_SDL_GetGamepadMappingForGUID = Module['_sdl3_SDL_GetGamepadMappingForGUID'] = (a0) => (_sdl3_SDL_GetGamepadMappingForGUID = Module['_sdl3_SDL_GetGamepadMappingForGUID'] = wasmExports['sdl3_SDL_GetGamepadMappingForGUID'])(a0);
var _sdl3_SDL_GetGamepadMappingForID = Module['_sdl3_SDL_GetGamepadMappingForID'] = (a0) => (_sdl3_SDL_GetGamepadMappingForID = Module['_sdl3_SDL_GetGamepadMappingForID'] = wasmExports['sdl3_SDL_GetGamepadMappingForID'])(a0);
var _sdl3_SDL_GetGamepadMappings = Module['_sdl3_SDL_GetGamepadMappings'] = (a0) => (_sdl3_SDL_GetGamepadMappings = Module['_sdl3_SDL_GetGamepadMappings'] = wasmExports['sdl3_SDL_GetGamepadMappings'])(a0);
var _sdl3_SDL_GetGamepadName = Module['_sdl3_SDL_GetGamepadName'] = (a0) => (_sdl3_SDL_GetGamepadName = Module['_sdl3_SDL_GetGamepadName'] = wasmExports['sdl3_SDL_GetGamepadName'])(a0);
var _sdl3_SDL_GetGamepadNameForID = Module['_sdl3_SDL_GetGamepadNameForID'] = (a0) => (_sdl3_SDL_GetGamepadNameForID = Module['_sdl3_SDL_GetGamepadNameForID'] = wasmExports['sdl3_SDL_GetGamepadNameForID'])(a0);
var _sdl3_SDL_GetGamepadPath = Module['_sdl3_SDL_GetGamepadPath'] = (a0) => (_sdl3_SDL_GetGamepadPath = Module['_sdl3_SDL_GetGamepadPath'] = wasmExports['sdl3_SDL_GetGamepadPath'])(a0);
var _sdl3_SDL_GetGamepadPathForID = Module['_sdl3_SDL_GetGamepadPathForID'] = (a0) => (_sdl3_SDL_GetGamepadPathForID = Module['_sdl3_SDL_GetGamepadPathForID'] = wasmExports['sdl3_SDL_GetGamepadPathForID'])(a0);
var _sdl3_SDL_GetGamepadPlayerIndex = Module['_sdl3_SDL_GetGamepadPlayerIndex'] = (a0) => (_sdl3_SDL_GetGamepadPlayerIndex = Module['_sdl3_SDL_GetGamepadPlayerIndex'] = wasmExports['sdl3_SDL_GetGamepadPlayerIndex'])(a0);
var _sdl3_SDL_GetGamepadPlayerIndexForID = Module['_sdl3_SDL_GetGamepadPlayerIndexForID'] = (a0) => (_sdl3_SDL_GetGamepadPlayerIndexForID = Module['_sdl3_SDL_GetGamepadPlayerIndexForID'] = wasmExports['sdl3_SDL_GetGamepadPlayerIndexForID'])(a0);
var _sdl3_SDL_GetGamepadPowerInfo = Module['_sdl3_SDL_GetGamepadPowerInfo'] = (a0, a1) => (_sdl3_SDL_GetGamepadPowerInfo = Module['_sdl3_SDL_GetGamepadPowerInfo'] = wasmExports['sdl3_SDL_GetGamepadPowerInfo'])(a0, a1);
var _sdl3_SDL_GetGamepadProduct = Module['_sdl3_SDL_GetGamepadProduct'] = (a0) => (_sdl3_SDL_GetGamepadProduct = Module['_sdl3_SDL_GetGamepadProduct'] = wasmExports['sdl3_SDL_GetGamepadProduct'])(a0);
var _sdl3_SDL_GetGamepadProductForID = Module['_sdl3_SDL_GetGamepadProductForID'] = (a0) => (_sdl3_SDL_GetGamepadProductForID = Module['_sdl3_SDL_GetGamepadProductForID'] = wasmExports['sdl3_SDL_GetGamepadProductForID'])(a0);
var _sdl3_SDL_GetGamepadProductVersion = Module['_sdl3_SDL_GetGamepadProductVersion'] = (a0) => (_sdl3_SDL_GetGamepadProductVersion = Module['_sdl3_SDL_GetGamepadProductVersion'] = wasmExports['sdl3_SDL_GetGamepadProductVersion'])(a0);
var _sdl3_SDL_GetGamepadProductVersionForID = Module['_sdl3_SDL_GetGamepadProductVersionForID'] = (a0) => (_sdl3_SDL_GetGamepadProductVersionForID = Module['_sdl3_SDL_GetGamepadProductVersionForID'] = wasmExports['sdl3_SDL_GetGamepadProductVersionForID'])(a0);
var _sdl3_SDL_GetGamepadProperties = Module['_sdl3_SDL_GetGamepadProperties'] = (a0) => (_sdl3_SDL_GetGamepadProperties = Module['_sdl3_SDL_GetGamepadProperties'] = wasmExports['sdl3_SDL_GetGamepadProperties'])(a0);
var _sdl3_SDL_GetGamepadSensorData = Module['_sdl3_SDL_GetGamepadSensorData'] = (a0, a1, a2, a3) => (_sdl3_SDL_GetGamepadSensorData = Module['_sdl3_SDL_GetGamepadSensorData'] = wasmExports['sdl3_SDL_GetGamepadSensorData'])(a0, a1, a2, a3);
var _sdl3_SDL_GetGamepadSensorDataRate = Module['_sdl3_SDL_GetGamepadSensorDataRate'] = (a0, a1) => (_sdl3_SDL_GetGamepadSensorDataRate = Module['_sdl3_SDL_GetGamepadSensorDataRate'] = wasmExports['sdl3_SDL_GetGamepadSensorDataRate'])(a0, a1);
var _sdl3_SDL_GetGamepadSerial = Module['_sdl3_SDL_GetGamepadSerial'] = (a0) => (_sdl3_SDL_GetGamepadSerial = Module['_sdl3_SDL_GetGamepadSerial'] = wasmExports['sdl3_SDL_GetGamepadSerial'])(a0);
var _sdl3_SDL_GetGamepadSteamHandle = Module['_sdl3_SDL_GetGamepadSteamHandle'] = (a0) => (_sdl3_SDL_GetGamepadSteamHandle = Module['_sdl3_SDL_GetGamepadSteamHandle'] = wasmExports['sdl3_SDL_GetGamepadSteamHandle'])(a0);
var _sdl3_SDL_GetGamepadStringForAxis = Module['_sdl3_SDL_GetGamepadStringForAxis'] = (a0) => (_sdl3_SDL_GetGamepadStringForAxis = Module['_sdl3_SDL_GetGamepadStringForAxis'] = wasmExports['sdl3_SDL_GetGamepadStringForAxis'])(a0);
var _sdl3_SDL_GetGamepadStringForButton = Module['_sdl3_SDL_GetGamepadStringForButton'] = (a0) => (_sdl3_SDL_GetGamepadStringForButton = Module['_sdl3_SDL_GetGamepadStringForButton'] = wasmExports['sdl3_SDL_GetGamepadStringForButton'])(a0);
var _sdl3_SDL_GetGamepadStringForType = Module['_sdl3_SDL_GetGamepadStringForType'] = (a0) => (_sdl3_SDL_GetGamepadStringForType = Module['_sdl3_SDL_GetGamepadStringForType'] = wasmExports['sdl3_SDL_GetGamepadStringForType'])(a0);
var _sdl3_SDL_GetGamepadTouchpadFinger = Module['_sdl3_SDL_GetGamepadTouchpadFinger'] = (a0, a1, a2, a3, a4, a5, a6) => (_sdl3_SDL_GetGamepadTouchpadFinger = Module['_sdl3_SDL_GetGamepadTouchpadFinger'] = wasmExports['sdl3_SDL_GetGamepadTouchpadFinger'])(a0, a1, a2, a3, a4, a5, a6);
var _sdl3_SDL_GetGamepadType = Module['_sdl3_SDL_GetGamepadType'] = (a0) => (_sdl3_SDL_GetGamepadType = Module['_sdl3_SDL_GetGamepadType'] = wasmExports['sdl3_SDL_GetGamepadType'])(a0);
var _sdl3_SDL_GetGamepadTypeForID = Module['_sdl3_SDL_GetGamepadTypeForID'] = (a0) => (_sdl3_SDL_GetGamepadTypeForID = Module['_sdl3_SDL_GetGamepadTypeForID'] = wasmExports['sdl3_SDL_GetGamepadTypeForID'])(a0);
var _sdl3_SDL_GetGamepadTypeFromString = Module['_sdl3_SDL_GetGamepadTypeFromString'] = (a0) => (_sdl3_SDL_GetGamepadTypeFromString = Module['_sdl3_SDL_GetGamepadTypeFromString'] = wasmExports['sdl3_SDL_GetGamepadTypeFromString'])(a0);
var _sdl3_SDL_GetGamepadVendor = Module['_sdl3_SDL_GetGamepadVendor'] = (a0) => (_sdl3_SDL_GetGamepadVendor = Module['_sdl3_SDL_GetGamepadVendor'] = wasmExports['sdl3_SDL_GetGamepadVendor'])(a0);
var _sdl3_SDL_GetGamepadVendorForID = Module['_sdl3_SDL_GetGamepadVendorForID'] = (a0) => (_sdl3_SDL_GetGamepadVendorForID = Module['_sdl3_SDL_GetGamepadVendorForID'] = wasmExports['sdl3_SDL_GetGamepadVendorForID'])(a0);
var _sdl3_SDL_GetGamepads = Module['_sdl3_SDL_GetGamepads'] = (a0) => (_sdl3_SDL_GetGamepads = Module['_sdl3_SDL_GetGamepads'] = wasmExports['sdl3_SDL_GetGamepads'])(a0);
var _sdl3_SDL_GetGlobalProperties = Module['_sdl3_SDL_GetGlobalProperties'] = () => (_sdl3_SDL_GetGlobalProperties = Module['_sdl3_SDL_GetGlobalProperties'] = wasmExports['sdl3_SDL_GetGlobalProperties'])();
var _sdl3_SDL_GetGrabbedWindow = Module['_sdl3_SDL_GetGrabbedWindow'] = () => (_sdl3_SDL_GetGrabbedWindow = Module['_sdl3_SDL_GetGrabbedWindow'] = wasmExports['sdl3_SDL_GetGrabbedWindow'])();
var _sdl3_SDL_GetHapticEffectStatus = Module['_sdl3_SDL_GetHapticEffectStatus'] = (a0, a1) => (_sdl3_SDL_GetHapticEffectStatus = Module['_sdl3_SDL_GetHapticEffectStatus'] = wasmExports['sdl3_SDL_GetHapticEffectStatus'])(a0, a1);
var _sdl3_SDL_GetHapticFeatures = Module['_sdl3_SDL_GetHapticFeatures'] = (a0) => (_sdl3_SDL_GetHapticFeatures = Module['_sdl3_SDL_GetHapticFeatures'] = wasmExports['sdl3_SDL_GetHapticFeatures'])(a0);
var _sdl3_SDL_GetHapticFromID = Module['_sdl3_SDL_GetHapticFromID'] = (a0) => (_sdl3_SDL_GetHapticFromID = Module['_sdl3_SDL_GetHapticFromID'] = wasmExports['sdl3_SDL_GetHapticFromID'])(a0);
var _sdl3_SDL_GetHapticID = Module['_sdl3_SDL_GetHapticID'] = (a0) => (_sdl3_SDL_GetHapticID = Module['_sdl3_SDL_GetHapticID'] = wasmExports['sdl3_SDL_GetHapticID'])(a0);
var _sdl3_SDL_GetHapticName = Module['_sdl3_SDL_GetHapticName'] = (a0) => (_sdl3_SDL_GetHapticName = Module['_sdl3_SDL_GetHapticName'] = wasmExports['sdl3_SDL_GetHapticName'])(a0);
var _sdl3_SDL_GetHapticNameForID = Module['_sdl3_SDL_GetHapticNameForID'] = (a0) => (_sdl3_SDL_GetHapticNameForID = Module['_sdl3_SDL_GetHapticNameForID'] = wasmExports['sdl3_SDL_GetHapticNameForID'])(a0);
var _sdl3_SDL_GetHaptics = Module['_sdl3_SDL_GetHaptics'] = (a0) => (_sdl3_SDL_GetHaptics = Module['_sdl3_SDL_GetHaptics'] = wasmExports['sdl3_SDL_GetHaptics'])(a0);
var _sdl3_SDL_GetHint = Module['_sdl3_SDL_GetHint'] = (a0) => (_sdl3_SDL_GetHint = Module['_sdl3_SDL_GetHint'] = wasmExports['sdl3_SDL_GetHint'])(a0);
var _sdl3_SDL_GetHintBoolean = Module['_sdl3_SDL_GetHintBoolean'] = (a0, a1) => (_sdl3_SDL_GetHintBoolean = Module['_sdl3_SDL_GetHintBoolean'] = wasmExports['sdl3_SDL_GetHintBoolean'])(a0, a1);
var _sdl3_SDL_GetIOProperties = Module['_sdl3_SDL_GetIOProperties'] = (a0) => (_sdl3_SDL_GetIOProperties = Module['_sdl3_SDL_GetIOProperties'] = wasmExports['sdl3_SDL_GetIOProperties'])(a0);
var _sdl3_SDL_GetIOSize = Module['_sdl3_SDL_GetIOSize'] = (a0) => (_sdl3_SDL_GetIOSize = Module['_sdl3_SDL_GetIOSize'] = wasmExports['sdl3_SDL_GetIOSize'])(a0);
var _sdl3_SDL_GetIOStatus = Module['_sdl3_SDL_GetIOStatus'] = (a0) => (_sdl3_SDL_GetIOStatus = Module['_sdl3_SDL_GetIOStatus'] = wasmExports['sdl3_SDL_GetIOStatus'])(a0);
var _sdl3_SDL_GetJoystickAxis = Module['_sdl3_SDL_GetJoystickAxis'] = (a0, a1) => (_sdl3_SDL_GetJoystickAxis = Module['_sdl3_SDL_GetJoystickAxis'] = wasmExports['sdl3_SDL_GetJoystickAxis'])(a0, a1);
var _sdl3_SDL_GetJoystickAxisInitialState = Module['_sdl3_SDL_GetJoystickAxisInitialState'] = (a0, a1, a2) => (_sdl3_SDL_GetJoystickAxisInitialState = Module['_sdl3_SDL_GetJoystickAxisInitialState'] = wasmExports['sdl3_SDL_GetJoystickAxisInitialState'])(a0, a1, a2);
var _sdl3_SDL_GetJoystickBall = Module['_sdl3_SDL_GetJoystickBall'] = (a0, a1, a2, a3) => (_sdl3_SDL_GetJoystickBall = Module['_sdl3_SDL_GetJoystickBall'] = wasmExports['sdl3_SDL_GetJoystickBall'])(a0, a1, a2, a3);
var _sdl3_SDL_GetJoystickButton = Module['_sdl3_SDL_GetJoystickButton'] = (a0, a1) => (_sdl3_SDL_GetJoystickButton = Module['_sdl3_SDL_GetJoystickButton'] = wasmExports['sdl3_SDL_GetJoystickButton'])(a0, a1);
var _sdl3_SDL_GetJoystickConnectionState = Module['_sdl3_SDL_GetJoystickConnectionState'] = (a0) => (_sdl3_SDL_GetJoystickConnectionState = Module['_sdl3_SDL_GetJoystickConnectionState'] = wasmExports['sdl3_SDL_GetJoystickConnectionState'])(a0);
var _sdl3_SDL_GetJoystickFirmwareVersion = Module['_sdl3_SDL_GetJoystickFirmwareVersion'] = (a0) => (_sdl3_SDL_GetJoystickFirmwareVersion = Module['_sdl3_SDL_GetJoystickFirmwareVersion'] = wasmExports['sdl3_SDL_GetJoystickFirmwareVersion'])(a0);
var _sdl3_SDL_GetJoystickFromID = Module['_sdl3_SDL_GetJoystickFromID'] = (a0) => (_sdl3_SDL_GetJoystickFromID = Module['_sdl3_SDL_GetJoystickFromID'] = wasmExports['sdl3_SDL_GetJoystickFromID'])(a0);
var _sdl3_SDL_GetJoystickFromPlayerIndex = Module['_sdl3_SDL_GetJoystickFromPlayerIndex'] = (a0) => (_sdl3_SDL_GetJoystickFromPlayerIndex = Module['_sdl3_SDL_GetJoystickFromPlayerIndex'] = wasmExports['sdl3_SDL_GetJoystickFromPlayerIndex'])(a0);
var _sdl3_SDL_GetJoystickGUID = Module['_sdl3_SDL_GetJoystickGUID'] = (a0) => (_sdl3_SDL_GetJoystickGUID = Module['_sdl3_SDL_GetJoystickGUID'] = wasmExports['sdl3_SDL_GetJoystickGUID'])(a0);
var _sdl3_SDL_GetJoystickGUIDForID = Module['_sdl3_SDL_GetJoystickGUIDForID'] = (a0) => (_sdl3_SDL_GetJoystickGUIDForID = Module['_sdl3_SDL_GetJoystickGUIDForID'] = wasmExports['sdl3_SDL_GetJoystickGUIDForID'])(a0);
var _sdl3_SDL_GetJoystickGUIDInfo = Module['_sdl3_SDL_GetJoystickGUIDInfo'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_GetJoystickGUIDInfo = Module['_sdl3_SDL_GetJoystickGUIDInfo'] = wasmExports['sdl3_SDL_GetJoystickGUIDInfo'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_GetJoystickHat = Module['_sdl3_SDL_GetJoystickHat'] = (a0, a1) => (_sdl3_SDL_GetJoystickHat = Module['_sdl3_SDL_GetJoystickHat'] = wasmExports['sdl3_SDL_GetJoystickHat'])(a0, a1);
var _sdl3_SDL_GetJoystickID = Module['_sdl3_SDL_GetJoystickID'] = (a0) => (_sdl3_SDL_GetJoystickID = Module['_sdl3_SDL_GetJoystickID'] = wasmExports['sdl3_SDL_GetJoystickID'])(a0);
var _sdl3_SDL_GetJoystickName = Module['_sdl3_SDL_GetJoystickName'] = (a0) => (_sdl3_SDL_GetJoystickName = Module['_sdl3_SDL_GetJoystickName'] = wasmExports['sdl3_SDL_GetJoystickName'])(a0);
var _sdl3_SDL_GetJoystickNameForID = Module['_sdl3_SDL_GetJoystickNameForID'] = (a0) => (_sdl3_SDL_GetJoystickNameForID = Module['_sdl3_SDL_GetJoystickNameForID'] = wasmExports['sdl3_SDL_GetJoystickNameForID'])(a0);
var _sdl3_SDL_GetJoystickPath = Module['_sdl3_SDL_GetJoystickPath'] = (a0) => (_sdl3_SDL_GetJoystickPath = Module['_sdl3_SDL_GetJoystickPath'] = wasmExports['sdl3_SDL_GetJoystickPath'])(a0);
var _sdl3_SDL_GetJoystickPathForID = Module['_sdl3_SDL_GetJoystickPathForID'] = (a0) => (_sdl3_SDL_GetJoystickPathForID = Module['_sdl3_SDL_GetJoystickPathForID'] = wasmExports['sdl3_SDL_GetJoystickPathForID'])(a0);
var _sdl3_SDL_GetJoystickPlayerIndex = Module['_sdl3_SDL_GetJoystickPlayerIndex'] = (a0) => (_sdl3_SDL_GetJoystickPlayerIndex = Module['_sdl3_SDL_GetJoystickPlayerIndex'] = wasmExports['sdl3_SDL_GetJoystickPlayerIndex'])(a0);
var _sdl3_SDL_GetJoystickPlayerIndexForID = Module['_sdl3_SDL_GetJoystickPlayerIndexForID'] = (a0) => (_sdl3_SDL_GetJoystickPlayerIndexForID = Module['_sdl3_SDL_GetJoystickPlayerIndexForID'] = wasmExports['sdl3_SDL_GetJoystickPlayerIndexForID'])(a0);
var _sdl3_SDL_GetJoystickPowerInfo = Module['_sdl3_SDL_GetJoystickPowerInfo'] = (a0, a1) => (_sdl3_SDL_GetJoystickPowerInfo = Module['_sdl3_SDL_GetJoystickPowerInfo'] = wasmExports['sdl3_SDL_GetJoystickPowerInfo'])(a0, a1);
var _sdl3_SDL_GetJoystickProduct = Module['_sdl3_SDL_GetJoystickProduct'] = (a0) => (_sdl3_SDL_GetJoystickProduct = Module['_sdl3_SDL_GetJoystickProduct'] = wasmExports['sdl3_SDL_GetJoystickProduct'])(a0);
var _sdl3_SDL_GetJoystickProductForID = Module['_sdl3_SDL_GetJoystickProductForID'] = (a0) => (_sdl3_SDL_GetJoystickProductForID = Module['_sdl3_SDL_GetJoystickProductForID'] = wasmExports['sdl3_SDL_GetJoystickProductForID'])(a0);
var _sdl3_SDL_GetJoystickProductVersion = Module['_sdl3_SDL_GetJoystickProductVersion'] = (a0) => (_sdl3_SDL_GetJoystickProductVersion = Module['_sdl3_SDL_GetJoystickProductVersion'] = wasmExports['sdl3_SDL_GetJoystickProductVersion'])(a0);
var _sdl3_SDL_GetJoystickProductVersionForID = Module['_sdl3_SDL_GetJoystickProductVersionForID'] = (a0) => (_sdl3_SDL_GetJoystickProductVersionForID = Module['_sdl3_SDL_GetJoystickProductVersionForID'] = wasmExports['sdl3_SDL_GetJoystickProductVersionForID'])(a0);
var _sdl3_SDL_GetJoystickProperties = Module['_sdl3_SDL_GetJoystickProperties'] = (a0) => (_sdl3_SDL_GetJoystickProperties = Module['_sdl3_SDL_GetJoystickProperties'] = wasmExports['sdl3_SDL_GetJoystickProperties'])(a0);
var _sdl3_SDL_GetJoystickSerial = Module['_sdl3_SDL_GetJoystickSerial'] = (a0) => (_sdl3_SDL_GetJoystickSerial = Module['_sdl3_SDL_GetJoystickSerial'] = wasmExports['sdl3_SDL_GetJoystickSerial'])(a0);
var _sdl3_SDL_GetJoystickType = Module['_sdl3_SDL_GetJoystickType'] = (a0) => (_sdl3_SDL_GetJoystickType = Module['_sdl3_SDL_GetJoystickType'] = wasmExports['sdl3_SDL_GetJoystickType'])(a0);
var _sdl3_SDL_GetJoystickTypeForID = Module['_sdl3_SDL_GetJoystickTypeForID'] = (a0) => (_sdl3_SDL_GetJoystickTypeForID = Module['_sdl3_SDL_GetJoystickTypeForID'] = wasmExports['sdl3_SDL_GetJoystickTypeForID'])(a0);
var _sdl3_SDL_GetJoystickVendor = Module['_sdl3_SDL_GetJoystickVendor'] = (a0) => (_sdl3_SDL_GetJoystickVendor = Module['_sdl3_SDL_GetJoystickVendor'] = wasmExports['sdl3_SDL_GetJoystickVendor'])(a0);
var _sdl3_SDL_GetJoystickVendorForID = Module['_sdl3_SDL_GetJoystickVendorForID'] = (a0) => (_sdl3_SDL_GetJoystickVendorForID = Module['_sdl3_SDL_GetJoystickVendorForID'] = wasmExports['sdl3_SDL_GetJoystickVendorForID'])(a0);
var _sdl3_SDL_GetJoysticks = Module['_sdl3_SDL_GetJoysticks'] = (a0) => (_sdl3_SDL_GetJoysticks = Module['_sdl3_SDL_GetJoysticks'] = wasmExports['sdl3_SDL_GetJoysticks'])(a0);
var _sdl3_SDL_GetKeyFromName = Module['_sdl3_SDL_GetKeyFromName'] = (a0) => (_sdl3_SDL_GetKeyFromName = Module['_sdl3_SDL_GetKeyFromName'] = wasmExports['sdl3_SDL_GetKeyFromName'])(a0);
var _sdl3_SDL_GetKeyFromScancode = Module['_sdl3_SDL_GetKeyFromScancode'] = (a0, a1, a2) => (_sdl3_SDL_GetKeyFromScancode = Module['_sdl3_SDL_GetKeyFromScancode'] = wasmExports['sdl3_SDL_GetKeyFromScancode'])(a0, a1, a2);
var _sdl3_SDL_GetKeyName = Module['_sdl3_SDL_GetKeyName'] = (a0) => (_sdl3_SDL_GetKeyName = Module['_sdl3_SDL_GetKeyName'] = wasmExports['sdl3_SDL_GetKeyName'])(a0);
var _sdl3_SDL_GetKeyboardFocus = Module['_sdl3_SDL_GetKeyboardFocus'] = () => (_sdl3_SDL_GetKeyboardFocus = Module['_sdl3_SDL_GetKeyboardFocus'] = wasmExports['sdl3_SDL_GetKeyboardFocus'])();
var _sdl3_SDL_GetKeyboardNameForID = Module['_sdl3_SDL_GetKeyboardNameForID'] = (a0) => (_sdl3_SDL_GetKeyboardNameForID = Module['_sdl3_SDL_GetKeyboardNameForID'] = wasmExports['sdl3_SDL_GetKeyboardNameForID'])(a0);
var _sdl3_SDL_GetKeyboardState = Module['_sdl3_SDL_GetKeyboardState'] = (a0) => (_sdl3_SDL_GetKeyboardState = Module['_sdl3_SDL_GetKeyboardState'] = wasmExports['sdl3_SDL_GetKeyboardState'])(a0);
var _sdl3_SDL_GetKeyboards = Module['_sdl3_SDL_GetKeyboards'] = (a0) => (_sdl3_SDL_GetKeyboards = Module['_sdl3_SDL_GetKeyboards'] = wasmExports['sdl3_SDL_GetKeyboards'])(a0);
var _sdl3_SDL_GetLogOutputFunction = Module['_sdl3_SDL_GetLogOutputFunction'] = (a0, a1) => (_sdl3_SDL_GetLogOutputFunction = Module['_sdl3_SDL_GetLogOutputFunction'] = wasmExports['sdl3_SDL_GetLogOutputFunction'])(a0, a1);
var _sdl3_SDL_GetLogPriority = Module['_sdl3_SDL_GetLogPriority'] = (a0) => (_sdl3_SDL_GetLogPriority = Module['_sdl3_SDL_GetLogPriority'] = wasmExports['sdl3_SDL_GetLogPriority'])(a0);
var _sdl3_SDL_GetMasksForPixelFormat = Module['_sdl3_SDL_GetMasksForPixelFormat'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_GetMasksForPixelFormat = Module['_sdl3_SDL_GetMasksForPixelFormat'] = wasmExports['sdl3_SDL_GetMasksForPixelFormat'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_GetMaxHapticEffects = Module['_sdl3_SDL_GetMaxHapticEffects'] = (a0) => (_sdl3_SDL_GetMaxHapticEffects = Module['_sdl3_SDL_GetMaxHapticEffects'] = wasmExports['sdl3_SDL_GetMaxHapticEffects'])(a0);
var _sdl3_SDL_GetMaxHapticEffectsPlaying = Module['_sdl3_SDL_GetMaxHapticEffectsPlaying'] = (a0) => (_sdl3_SDL_GetMaxHapticEffectsPlaying = Module['_sdl3_SDL_GetMaxHapticEffectsPlaying'] = wasmExports['sdl3_SDL_GetMaxHapticEffectsPlaying'])(a0);
var _sdl3_SDL_GetMice = Module['_sdl3_SDL_GetMice'] = (a0) => (_sdl3_SDL_GetMice = Module['_sdl3_SDL_GetMice'] = wasmExports['sdl3_SDL_GetMice'])(a0);
var _sdl3_SDL_GetModState = Module['_sdl3_SDL_GetModState'] = () => (_sdl3_SDL_GetModState = Module['_sdl3_SDL_GetModState'] = wasmExports['sdl3_SDL_GetModState'])();
var _sdl3_SDL_GetMouseFocus = Module['_sdl3_SDL_GetMouseFocus'] = () => (_sdl3_SDL_GetMouseFocus = Module['_sdl3_SDL_GetMouseFocus'] = wasmExports['sdl3_SDL_GetMouseFocus'])();
var _sdl3_SDL_GetMouseNameForID = Module['_sdl3_SDL_GetMouseNameForID'] = (a0) => (_sdl3_SDL_GetMouseNameForID = Module['_sdl3_SDL_GetMouseNameForID'] = wasmExports['sdl3_SDL_GetMouseNameForID'])(a0);
var _sdl3_SDL_GetNaturalDisplayOrientation = Module['_sdl3_SDL_GetNaturalDisplayOrientation'] = (a0) => (_sdl3_SDL_GetNaturalDisplayOrientation = Module['_sdl3_SDL_GetNaturalDisplayOrientation'] = wasmExports['sdl3_SDL_GetNaturalDisplayOrientation'])(a0);
var _sdl3_SDL_GetNumAudioDrivers = Module['_sdl3_SDL_GetNumAudioDrivers'] = () => (_sdl3_SDL_GetNumAudioDrivers = Module['_sdl3_SDL_GetNumAudioDrivers'] = wasmExports['sdl3_SDL_GetNumAudioDrivers'])();
var _sdl3_SDL_GetNumCameraDrivers = Module['_sdl3_SDL_GetNumCameraDrivers'] = () => (_sdl3_SDL_GetNumCameraDrivers = Module['_sdl3_SDL_GetNumCameraDrivers'] = wasmExports['sdl3_SDL_GetNumCameraDrivers'])();
var _sdl3_SDL_GetNumGPUDrivers = Module['_sdl3_SDL_GetNumGPUDrivers'] = () => (_sdl3_SDL_GetNumGPUDrivers = Module['_sdl3_SDL_GetNumGPUDrivers'] = wasmExports['sdl3_SDL_GetNumGPUDrivers'])();
var _sdl3_SDL_GetNumGamepadTouchpadFingers = Module['_sdl3_SDL_GetNumGamepadTouchpadFingers'] = (a0, a1) => (_sdl3_SDL_GetNumGamepadTouchpadFingers = Module['_sdl3_SDL_GetNumGamepadTouchpadFingers'] = wasmExports['sdl3_SDL_GetNumGamepadTouchpadFingers'])(a0, a1);
var _sdl3_SDL_GetNumGamepadTouchpads = Module['_sdl3_SDL_GetNumGamepadTouchpads'] = (a0) => (_sdl3_SDL_GetNumGamepadTouchpads = Module['_sdl3_SDL_GetNumGamepadTouchpads'] = wasmExports['sdl3_SDL_GetNumGamepadTouchpads'])(a0);
var _sdl3_SDL_GetNumHapticAxes = Module['_sdl3_SDL_GetNumHapticAxes'] = (a0) => (_sdl3_SDL_GetNumHapticAxes = Module['_sdl3_SDL_GetNumHapticAxes'] = wasmExports['sdl3_SDL_GetNumHapticAxes'])(a0);
var _sdl3_SDL_GetNumJoystickAxes = Module['_sdl3_SDL_GetNumJoystickAxes'] = (a0) => (_sdl3_SDL_GetNumJoystickAxes = Module['_sdl3_SDL_GetNumJoystickAxes'] = wasmExports['sdl3_SDL_GetNumJoystickAxes'])(a0);
var _sdl3_SDL_GetNumJoystickBalls = Module['_sdl3_SDL_GetNumJoystickBalls'] = (a0) => (_sdl3_SDL_GetNumJoystickBalls = Module['_sdl3_SDL_GetNumJoystickBalls'] = wasmExports['sdl3_SDL_GetNumJoystickBalls'])(a0);
var _sdl3_SDL_GetNumJoystickButtons = Module['_sdl3_SDL_GetNumJoystickButtons'] = (a0) => (_sdl3_SDL_GetNumJoystickButtons = Module['_sdl3_SDL_GetNumJoystickButtons'] = wasmExports['sdl3_SDL_GetNumJoystickButtons'])(a0);
var _sdl3_SDL_GetNumJoystickHats = Module['_sdl3_SDL_GetNumJoystickHats'] = (a0) => (_sdl3_SDL_GetNumJoystickHats = Module['_sdl3_SDL_GetNumJoystickHats'] = wasmExports['sdl3_SDL_GetNumJoystickHats'])(a0);
var _sdl3_SDL_GetNumLogicalCPUCores = Module['_sdl3_SDL_GetNumLogicalCPUCores'] = () => (_sdl3_SDL_GetNumLogicalCPUCores = Module['_sdl3_SDL_GetNumLogicalCPUCores'] = wasmExports['sdl3_SDL_GetNumLogicalCPUCores'])();
var _sdl3_SDL_GetNumRenderDrivers = Module['_sdl3_SDL_GetNumRenderDrivers'] = () => (_sdl3_SDL_GetNumRenderDrivers = Module['_sdl3_SDL_GetNumRenderDrivers'] = wasmExports['sdl3_SDL_GetNumRenderDrivers'])();
var _sdl3_SDL_GetNumVideoDrivers = Module['_sdl3_SDL_GetNumVideoDrivers'] = () => (_sdl3_SDL_GetNumVideoDrivers = Module['_sdl3_SDL_GetNumVideoDrivers'] = wasmExports['sdl3_SDL_GetNumVideoDrivers'])();
var _sdl3_SDL_GetNumberProperty = Module['_sdl3_SDL_GetNumberProperty'] = (a0, a1, a2) => (_sdl3_SDL_GetNumberProperty = Module['_sdl3_SDL_GetNumberProperty'] = wasmExports['sdl3_SDL_GetNumberProperty'])(a0, a1, a2);
var _sdl3_SDL_GetPathInfo = Module['_sdl3_SDL_GetPathInfo'] = (a0, a1) => (_sdl3_SDL_GetPathInfo = Module['_sdl3_SDL_GetPathInfo'] = wasmExports['sdl3_SDL_GetPathInfo'])(a0, a1);
var _sdl3_SDL_GetPerformanceCounter = Module['_sdl3_SDL_GetPerformanceCounter'] = () => (_sdl3_SDL_GetPerformanceCounter = Module['_sdl3_SDL_GetPerformanceCounter'] = wasmExports['sdl3_SDL_GetPerformanceCounter'])();
var _sdl3_SDL_GetPerformanceFrequency = Module['_sdl3_SDL_GetPerformanceFrequency'] = () => (_sdl3_SDL_GetPerformanceFrequency = Module['_sdl3_SDL_GetPerformanceFrequency'] = wasmExports['sdl3_SDL_GetPerformanceFrequency'])();
var _sdl3_SDL_GetPixelFormatDetails = Module['_sdl3_SDL_GetPixelFormatDetails'] = (a0) => (_sdl3_SDL_GetPixelFormatDetails = Module['_sdl3_SDL_GetPixelFormatDetails'] = wasmExports['sdl3_SDL_GetPixelFormatDetails'])(a0);
var _sdl3_SDL_GetPixelFormatForMasks = Module['_sdl3_SDL_GetPixelFormatForMasks'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_GetPixelFormatForMasks = Module['_sdl3_SDL_GetPixelFormatForMasks'] = wasmExports['sdl3_SDL_GetPixelFormatForMasks'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_GetPixelFormatName = Module['_sdl3_SDL_GetPixelFormatName'] = (a0) => (_sdl3_SDL_GetPixelFormatName = Module['_sdl3_SDL_GetPixelFormatName'] = wasmExports['sdl3_SDL_GetPixelFormatName'])(a0);
var _sdl3_SDL_GetPlatform = Module['_sdl3_SDL_GetPlatform'] = () => (_sdl3_SDL_GetPlatform = Module['_sdl3_SDL_GetPlatform'] = wasmExports['sdl3_SDL_GetPlatform'])();
var _sdl3_SDL_GetPointerProperty = Module['_sdl3_SDL_GetPointerProperty'] = (a0, a1, a2) => (_sdl3_SDL_GetPointerProperty = Module['_sdl3_SDL_GetPointerProperty'] = wasmExports['sdl3_SDL_GetPointerProperty'])(a0, a1, a2);
var _sdl3_SDL_GetPowerInfo = Module['_sdl3_SDL_GetPowerInfo'] = (a0, a1) => (_sdl3_SDL_GetPowerInfo = Module['_sdl3_SDL_GetPowerInfo'] = wasmExports['sdl3_SDL_GetPowerInfo'])(a0, a1);
var _sdl3_SDL_GetPrefPath = Module['_sdl3_SDL_GetPrefPath'] = (a0, a1) => (_sdl3_SDL_GetPrefPath = Module['_sdl3_SDL_GetPrefPath'] = wasmExports['sdl3_SDL_GetPrefPath'])(a0, a1);
var _sdl3_SDL_GetPreferredLocales = Module['_sdl3_SDL_GetPreferredLocales'] = (a0) => (_sdl3_SDL_GetPreferredLocales = Module['_sdl3_SDL_GetPreferredLocales'] = wasmExports['sdl3_SDL_GetPreferredLocales'])(a0);
var _sdl3_SDL_GetPrimaryDisplay = Module['_sdl3_SDL_GetPrimaryDisplay'] = () => (_sdl3_SDL_GetPrimaryDisplay = Module['_sdl3_SDL_GetPrimaryDisplay'] = wasmExports['sdl3_SDL_GetPrimaryDisplay'])();
var _sdl3_SDL_GetPrimarySelectionText = Module['_sdl3_SDL_GetPrimarySelectionText'] = () => (_sdl3_SDL_GetPrimarySelectionText = Module['_sdl3_SDL_GetPrimarySelectionText'] = wasmExports['sdl3_SDL_GetPrimarySelectionText'])();
var _sdl3_SDL_GetProcessInput = Module['_sdl3_SDL_GetProcessInput'] = (a0) => (_sdl3_SDL_GetProcessInput = Module['_sdl3_SDL_GetProcessInput'] = wasmExports['sdl3_SDL_GetProcessInput'])(a0);
var _sdl3_SDL_GetProcessOutput = Module['_sdl3_SDL_GetProcessOutput'] = (a0) => (_sdl3_SDL_GetProcessOutput = Module['_sdl3_SDL_GetProcessOutput'] = wasmExports['sdl3_SDL_GetProcessOutput'])(a0);
var _sdl3_SDL_GetProcessProperties = Module['_sdl3_SDL_GetProcessProperties'] = (a0) => (_sdl3_SDL_GetProcessProperties = Module['_sdl3_SDL_GetProcessProperties'] = wasmExports['sdl3_SDL_GetProcessProperties'])(a0);
var _sdl3_SDL_GetPropertyType = Module['_sdl3_SDL_GetPropertyType'] = (a0, a1) => (_sdl3_SDL_GetPropertyType = Module['_sdl3_SDL_GetPropertyType'] = wasmExports['sdl3_SDL_GetPropertyType'])(a0, a1);
var _sdl3_SDL_GetRGB = Module['_sdl3_SDL_GetRGB'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_GetRGB = Module['_sdl3_SDL_GetRGB'] = wasmExports['sdl3_SDL_GetRGB'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_GetRGBA = Module['_sdl3_SDL_GetRGBA'] = (a0, a1, a2, a3, a4, a5, a6) => (_sdl3_SDL_GetRGBA = Module['_sdl3_SDL_GetRGBA'] = wasmExports['sdl3_SDL_GetRGBA'])(a0, a1, a2, a3, a4, a5, a6);
var _sdl3_SDL_GetRealGamepadType = Module['_sdl3_SDL_GetRealGamepadType'] = (a0) => (_sdl3_SDL_GetRealGamepadType = Module['_sdl3_SDL_GetRealGamepadType'] = wasmExports['sdl3_SDL_GetRealGamepadType'])(a0);
var _sdl3_SDL_GetRealGamepadTypeForID = Module['_sdl3_SDL_GetRealGamepadTypeForID'] = (a0) => (_sdl3_SDL_GetRealGamepadTypeForID = Module['_sdl3_SDL_GetRealGamepadTypeForID'] = wasmExports['sdl3_SDL_GetRealGamepadTypeForID'])(a0);
var _sdl3_SDL_GetRectAndLineIntersection = Module['_sdl3_SDL_GetRectAndLineIntersection'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_GetRectAndLineIntersection = Module['_sdl3_SDL_GetRectAndLineIntersection'] = wasmExports['sdl3_SDL_GetRectAndLineIntersection'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_GetRectAndLineIntersectionFloat = Module['_sdl3_SDL_GetRectAndLineIntersectionFloat'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_GetRectAndLineIntersectionFloat = Module['_sdl3_SDL_GetRectAndLineIntersectionFloat'] = wasmExports['sdl3_SDL_GetRectAndLineIntersectionFloat'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_GetRectEnclosingPoints = Module['_sdl3_SDL_GetRectEnclosingPoints'] = (a0, a1, a2, a3) => (_sdl3_SDL_GetRectEnclosingPoints = Module['_sdl3_SDL_GetRectEnclosingPoints'] = wasmExports['sdl3_SDL_GetRectEnclosingPoints'])(a0, a1, a2, a3);
var _sdl3_SDL_GetRectEnclosingPointsFloat = Module['_sdl3_SDL_GetRectEnclosingPointsFloat'] = (a0, a1, a2, a3) => (_sdl3_SDL_GetRectEnclosingPointsFloat = Module['_sdl3_SDL_GetRectEnclosingPointsFloat'] = wasmExports['sdl3_SDL_GetRectEnclosingPointsFloat'])(a0, a1, a2, a3);
var _sdl3_SDL_GetRectIntersection = Module['_sdl3_SDL_GetRectIntersection'] = (a0, a1, a2) => (_sdl3_SDL_GetRectIntersection = Module['_sdl3_SDL_GetRectIntersection'] = wasmExports['sdl3_SDL_GetRectIntersection'])(a0, a1, a2);
var _sdl3_SDL_GetRectIntersectionFloat = Module['_sdl3_SDL_GetRectIntersectionFloat'] = (a0, a1, a2) => (_sdl3_SDL_GetRectIntersectionFloat = Module['_sdl3_SDL_GetRectIntersectionFloat'] = wasmExports['sdl3_SDL_GetRectIntersectionFloat'])(a0, a1, a2);
var _sdl3_SDL_GetRectUnion = Module['_sdl3_SDL_GetRectUnion'] = (a0, a1, a2) => (_sdl3_SDL_GetRectUnion = Module['_sdl3_SDL_GetRectUnion'] = wasmExports['sdl3_SDL_GetRectUnion'])(a0, a1, a2);
var _sdl3_SDL_GetRectUnionFloat = Module['_sdl3_SDL_GetRectUnionFloat'] = (a0, a1, a2) => (_sdl3_SDL_GetRectUnionFloat = Module['_sdl3_SDL_GetRectUnionFloat'] = wasmExports['sdl3_SDL_GetRectUnionFloat'])(a0, a1, a2);
var _sdl3_SDL_GetRelativeMouseState = Module['_sdl3_SDL_GetRelativeMouseState'] = (a0, a1) => (_sdl3_SDL_GetRelativeMouseState = Module['_sdl3_SDL_GetRelativeMouseState'] = wasmExports['sdl3_SDL_GetRelativeMouseState'])(a0, a1);
var _sdl3_SDL_GetRenderClipRect = Module['_sdl3_SDL_GetRenderClipRect'] = (a0, a1) => (_sdl3_SDL_GetRenderClipRect = Module['_sdl3_SDL_GetRenderClipRect'] = wasmExports['sdl3_SDL_GetRenderClipRect'])(a0, a1);
var _sdl3_SDL_GetRenderColorScale = Module['_sdl3_SDL_GetRenderColorScale'] = (a0, a1) => (_sdl3_SDL_GetRenderColorScale = Module['_sdl3_SDL_GetRenderColorScale'] = wasmExports['sdl3_SDL_GetRenderColorScale'])(a0, a1);
var _sdl3_SDL_GetRenderDrawBlendMode = Module['_sdl3_SDL_GetRenderDrawBlendMode'] = (a0, a1) => (_sdl3_SDL_GetRenderDrawBlendMode = Module['_sdl3_SDL_GetRenderDrawBlendMode'] = wasmExports['sdl3_SDL_GetRenderDrawBlendMode'])(a0, a1);
var _sdl3_SDL_GetRenderDrawColor = Module['_sdl3_SDL_GetRenderDrawColor'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_GetRenderDrawColor = Module['_sdl3_SDL_GetRenderDrawColor'] = wasmExports['sdl3_SDL_GetRenderDrawColor'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_GetRenderDrawColorFloat = Module['_sdl3_SDL_GetRenderDrawColorFloat'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_GetRenderDrawColorFloat = Module['_sdl3_SDL_GetRenderDrawColorFloat'] = wasmExports['sdl3_SDL_GetRenderDrawColorFloat'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_GetRenderDriver = Module['_sdl3_SDL_GetRenderDriver'] = (a0) => (_sdl3_SDL_GetRenderDriver = Module['_sdl3_SDL_GetRenderDriver'] = wasmExports['sdl3_SDL_GetRenderDriver'])(a0);
var _sdl3_SDL_GetRenderLogicalPresentation = Module['_sdl3_SDL_GetRenderLogicalPresentation'] = (a0, a1, a2, a3) => (_sdl3_SDL_GetRenderLogicalPresentation = Module['_sdl3_SDL_GetRenderLogicalPresentation'] = wasmExports['sdl3_SDL_GetRenderLogicalPresentation'])(a0, a1, a2, a3);
var _sdl3_SDL_GetRenderLogicalPresentationRect = Module['_sdl3_SDL_GetRenderLogicalPresentationRect'] = (a0, a1) => (_sdl3_SDL_GetRenderLogicalPresentationRect = Module['_sdl3_SDL_GetRenderLogicalPresentationRect'] = wasmExports['sdl3_SDL_GetRenderLogicalPresentationRect'])(a0, a1);
var _sdl3_SDL_GetRenderMetalCommandEncoder = Module['_sdl3_SDL_GetRenderMetalCommandEncoder'] = (a0) => (_sdl3_SDL_GetRenderMetalCommandEncoder = Module['_sdl3_SDL_GetRenderMetalCommandEncoder'] = wasmExports['sdl3_SDL_GetRenderMetalCommandEncoder'])(a0);
var _sdl3_SDL_GetRenderMetalLayer = Module['_sdl3_SDL_GetRenderMetalLayer'] = (a0) => (_sdl3_SDL_GetRenderMetalLayer = Module['_sdl3_SDL_GetRenderMetalLayer'] = wasmExports['sdl3_SDL_GetRenderMetalLayer'])(a0);
var _sdl3_SDL_GetRenderOutputSize = Module['_sdl3_SDL_GetRenderOutputSize'] = (a0, a1, a2) => (_sdl3_SDL_GetRenderOutputSize = Module['_sdl3_SDL_GetRenderOutputSize'] = wasmExports['sdl3_SDL_GetRenderOutputSize'])(a0, a1, a2);
var _sdl3_SDL_GetRenderSafeArea = Module['_sdl3_SDL_GetRenderSafeArea'] = (a0, a1) => (_sdl3_SDL_GetRenderSafeArea = Module['_sdl3_SDL_GetRenderSafeArea'] = wasmExports['sdl3_SDL_GetRenderSafeArea'])(a0, a1);
var _sdl3_SDL_GetRenderScale = Module['_sdl3_SDL_GetRenderScale'] = (a0, a1, a2) => (_sdl3_SDL_GetRenderScale = Module['_sdl3_SDL_GetRenderScale'] = wasmExports['sdl3_SDL_GetRenderScale'])(a0, a1, a2);
var _sdl3_SDL_GetRenderTarget = Module['_sdl3_SDL_GetRenderTarget'] = (a0) => (_sdl3_SDL_GetRenderTarget = Module['_sdl3_SDL_GetRenderTarget'] = wasmExports['sdl3_SDL_GetRenderTarget'])(a0);
var _sdl3_SDL_GetRenderVSync = Module['_sdl3_SDL_GetRenderVSync'] = (a0, a1) => (_sdl3_SDL_GetRenderVSync = Module['_sdl3_SDL_GetRenderVSync'] = wasmExports['sdl3_SDL_GetRenderVSync'])(a0, a1);
var _sdl3_SDL_GetRenderViewport = Module['_sdl3_SDL_GetRenderViewport'] = (a0, a1) => (_sdl3_SDL_GetRenderViewport = Module['_sdl3_SDL_GetRenderViewport'] = wasmExports['sdl3_SDL_GetRenderViewport'])(a0, a1);
var _sdl3_SDL_GetRenderWindow = Module['_sdl3_SDL_GetRenderWindow'] = (a0) => (_sdl3_SDL_GetRenderWindow = Module['_sdl3_SDL_GetRenderWindow'] = wasmExports['sdl3_SDL_GetRenderWindow'])(a0);
var _sdl3_SDL_GetRenderer = Module['_sdl3_SDL_GetRenderer'] = (a0) => (_sdl3_SDL_GetRenderer = Module['_sdl3_SDL_GetRenderer'] = wasmExports['sdl3_SDL_GetRenderer'])(a0);
var _sdl3_SDL_GetRendererFromTexture = Module['_sdl3_SDL_GetRendererFromTexture'] = (a0) => (_sdl3_SDL_GetRendererFromTexture = Module['_sdl3_SDL_GetRendererFromTexture'] = wasmExports['sdl3_SDL_GetRendererFromTexture'])(a0);
var _sdl3_SDL_GetRendererName = Module['_sdl3_SDL_GetRendererName'] = (a0) => (_sdl3_SDL_GetRendererName = Module['_sdl3_SDL_GetRendererName'] = wasmExports['sdl3_SDL_GetRendererName'])(a0);
var _sdl3_SDL_GetRendererProperties = Module['_sdl3_SDL_GetRendererProperties'] = (a0) => (_sdl3_SDL_GetRendererProperties = Module['_sdl3_SDL_GetRendererProperties'] = wasmExports['sdl3_SDL_GetRendererProperties'])(a0);
var _sdl3_SDL_GetRevision = Module['_sdl3_SDL_GetRevision'] = () => (_sdl3_SDL_GetRevision = Module['_sdl3_SDL_GetRevision'] = wasmExports['sdl3_SDL_GetRevision'])();
var _sdl3_SDL_GetSIMDAlignment = Module['_sdl3_SDL_GetSIMDAlignment'] = () => (_sdl3_SDL_GetSIMDAlignment = Module['_sdl3_SDL_GetSIMDAlignment'] = wasmExports['sdl3_SDL_GetSIMDAlignment'])();
var _sdl3_SDL_GetSandbox = Module['_sdl3_SDL_GetSandbox'] = () => (_sdl3_SDL_GetSandbox = Module['_sdl3_SDL_GetSandbox'] = wasmExports['sdl3_SDL_GetSandbox'])();
var _sdl3_SDL_GetScancodeFromKey = Module['_sdl3_SDL_GetScancodeFromKey'] = (a0, a1) => (_sdl3_SDL_GetScancodeFromKey = Module['_sdl3_SDL_GetScancodeFromKey'] = wasmExports['sdl3_SDL_GetScancodeFromKey'])(a0, a1);
var _sdl3_SDL_GetScancodeFromName = Module['_sdl3_SDL_GetScancodeFromName'] = (a0) => (_sdl3_SDL_GetScancodeFromName = Module['_sdl3_SDL_GetScancodeFromName'] = wasmExports['sdl3_SDL_GetScancodeFromName'])(a0);
var _sdl3_SDL_GetScancodeName = Module['_sdl3_SDL_GetScancodeName'] = (a0) => (_sdl3_SDL_GetScancodeName = Module['_sdl3_SDL_GetScancodeName'] = wasmExports['sdl3_SDL_GetScancodeName'])(a0);
var _sdl3_SDL_GetSemaphoreValue = Module['_sdl3_SDL_GetSemaphoreValue'] = (a0) => (_sdl3_SDL_GetSemaphoreValue = Module['_sdl3_SDL_GetSemaphoreValue'] = wasmExports['sdl3_SDL_GetSemaphoreValue'])(a0);
var _sdl3_SDL_GetSensorData = Module['_sdl3_SDL_GetSensorData'] = (a0, a1, a2) => (_sdl3_SDL_GetSensorData = Module['_sdl3_SDL_GetSensorData'] = wasmExports['sdl3_SDL_GetSensorData'])(a0, a1, a2);
var _sdl3_SDL_GetSensorFromID = Module['_sdl3_SDL_GetSensorFromID'] = (a0) => (_sdl3_SDL_GetSensorFromID = Module['_sdl3_SDL_GetSensorFromID'] = wasmExports['sdl3_SDL_GetSensorFromID'])(a0);
var _sdl3_SDL_GetSensorID = Module['_sdl3_SDL_GetSensorID'] = (a0) => (_sdl3_SDL_GetSensorID = Module['_sdl3_SDL_GetSensorID'] = wasmExports['sdl3_SDL_GetSensorID'])(a0);
var _sdl3_SDL_GetSensorName = Module['_sdl3_SDL_GetSensorName'] = (a0) => (_sdl3_SDL_GetSensorName = Module['_sdl3_SDL_GetSensorName'] = wasmExports['sdl3_SDL_GetSensorName'])(a0);
var _sdl3_SDL_GetSensorNameForID = Module['_sdl3_SDL_GetSensorNameForID'] = (a0) => (_sdl3_SDL_GetSensorNameForID = Module['_sdl3_SDL_GetSensorNameForID'] = wasmExports['sdl3_SDL_GetSensorNameForID'])(a0);
var _sdl3_SDL_GetSensorNonPortableType = Module['_sdl3_SDL_GetSensorNonPortableType'] = (a0) => (_sdl3_SDL_GetSensorNonPortableType = Module['_sdl3_SDL_GetSensorNonPortableType'] = wasmExports['sdl3_SDL_GetSensorNonPortableType'])(a0);
var _sdl3_SDL_GetSensorNonPortableTypeForID = Module['_sdl3_SDL_GetSensorNonPortableTypeForID'] = (a0) => (_sdl3_SDL_GetSensorNonPortableTypeForID = Module['_sdl3_SDL_GetSensorNonPortableTypeForID'] = wasmExports['sdl3_SDL_GetSensorNonPortableTypeForID'])(a0);
var _sdl3_SDL_GetSensorProperties = Module['_sdl3_SDL_GetSensorProperties'] = (a0) => (_sdl3_SDL_GetSensorProperties = Module['_sdl3_SDL_GetSensorProperties'] = wasmExports['sdl3_SDL_GetSensorProperties'])(a0);
var _sdl3_SDL_GetSensorType = Module['_sdl3_SDL_GetSensorType'] = (a0) => (_sdl3_SDL_GetSensorType = Module['_sdl3_SDL_GetSensorType'] = wasmExports['sdl3_SDL_GetSensorType'])(a0);
var _sdl3_SDL_GetSensorTypeForID = Module['_sdl3_SDL_GetSensorTypeForID'] = (a0) => (_sdl3_SDL_GetSensorTypeForID = Module['_sdl3_SDL_GetSensorTypeForID'] = wasmExports['sdl3_SDL_GetSensorTypeForID'])(a0);
var _sdl3_SDL_GetSensors = Module['_sdl3_SDL_GetSensors'] = (a0) => (_sdl3_SDL_GetSensors = Module['_sdl3_SDL_GetSensors'] = wasmExports['sdl3_SDL_GetSensors'])(a0);
var _sdl3_SDL_GetSilenceValueForFormat = Module['_sdl3_SDL_GetSilenceValueForFormat'] = (a0) => (_sdl3_SDL_GetSilenceValueForFormat = Module['_sdl3_SDL_GetSilenceValueForFormat'] = wasmExports['sdl3_SDL_GetSilenceValueForFormat'])(a0);
var _sdl3_SDL_GetStorageFileSize = Module['_sdl3_SDL_GetStorageFileSize'] = (a0, a1, a2) => (_sdl3_SDL_GetStorageFileSize = Module['_sdl3_SDL_GetStorageFileSize'] = wasmExports['sdl3_SDL_GetStorageFileSize'])(a0, a1, a2);
var _sdl3_SDL_GetStoragePathInfo = Module['_sdl3_SDL_GetStoragePathInfo'] = (a0, a1, a2) => (_sdl3_SDL_GetStoragePathInfo = Module['_sdl3_SDL_GetStoragePathInfo'] = wasmExports['sdl3_SDL_GetStoragePathInfo'])(a0, a1, a2);
var _sdl3_SDL_GetStorageSpaceRemaining = Module['_sdl3_SDL_GetStorageSpaceRemaining'] = (a0) => (_sdl3_SDL_GetStorageSpaceRemaining = Module['_sdl3_SDL_GetStorageSpaceRemaining'] = wasmExports['sdl3_SDL_GetStorageSpaceRemaining'])(a0);
var _sdl3_SDL_GetStringProperty = Module['_sdl3_SDL_GetStringProperty'] = (a0, a1, a2) => (_sdl3_SDL_GetStringProperty = Module['_sdl3_SDL_GetStringProperty'] = wasmExports['sdl3_SDL_GetStringProperty'])(a0, a1, a2);
var _sdl3_SDL_GetSurfaceAlphaMod = Module['_sdl3_SDL_GetSurfaceAlphaMod'] = (a0, a1) => (_sdl3_SDL_GetSurfaceAlphaMod = Module['_sdl3_SDL_GetSurfaceAlphaMod'] = wasmExports['sdl3_SDL_GetSurfaceAlphaMod'])(a0, a1);
var _sdl3_SDL_GetSurfaceBlendMode = Module['_sdl3_SDL_GetSurfaceBlendMode'] = (a0, a1) => (_sdl3_SDL_GetSurfaceBlendMode = Module['_sdl3_SDL_GetSurfaceBlendMode'] = wasmExports['sdl3_SDL_GetSurfaceBlendMode'])(a0, a1);
var _sdl3_SDL_GetSurfaceClipRect = Module['_sdl3_SDL_GetSurfaceClipRect'] = (a0, a1) => (_sdl3_SDL_GetSurfaceClipRect = Module['_sdl3_SDL_GetSurfaceClipRect'] = wasmExports['sdl3_SDL_GetSurfaceClipRect'])(a0, a1);
var _sdl3_SDL_GetSurfaceColorKey = Module['_sdl3_SDL_GetSurfaceColorKey'] = (a0, a1) => (_sdl3_SDL_GetSurfaceColorKey = Module['_sdl3_SDL_GetSurfaceColorKey'] = wasmExports['sdl3_SDL_GetSurfaceColorKey'])(a0, a1);
var _sdl3_SDL_GetSurfaceColorMod = Module['_sdl3_SDL_GetSurfaceColorMod'] = (a0, a1, a2, a3) => (_sdl3_SDL_GetSurfaceColorMod = Module['_sdl3_SDL_GetSurfaceColorMod'] = wasmExports['sdl3_SDL_GetSurfaceColorMod'])(a0, a1, a2, a3);
var _sdl3_SDL_GetSurfaceColorspace = Module['_sdl3_SDL_GetSurfaceColorspace'] = (a0) => (_sdl3_SDL_GetSurfaceColorspace = Module['_sdl3_SDL_GetSurfaceColorspace'] = wasmExports['sdl3_SDL_GetSurfaceColorspace'])(a0);
var _sdl3_SDL_GetSurfaceImages = Module['_sdl3_SDL_GetSurfaceImages'] = (a0, a1) => (_sdl3_SDL_GetSurfaceImages = Module['_sdl3_SDL_GetSurfaceImages'] = wasmExports['sdl3_SDL_GetSurfaceImages'])(a0, a1);
var _sdl3_SDL_GetSurfacePalette = Module['_sdl3_SDL_GetSurfacePalette'] = (a0) => (_sdl3_SDL_GetSurfacePalette = Module['_sdl3_SDL_GetSurfacePalette'] = wasmExports['sdl3_SDL_GetSurfacePalette'])(a0);
var _sdl3_SDL_GetSurfaceProperties = Module['_sdl3_SDL_GetSurfaceProperties'] = (a0) => (_sdl3_SDL_GetSurfaceProperties = Module['_sdl3_SDL_GetSurfaceProperties'] = wasmExports['sdl3_SDL_GetSurfaceProperties'])(a0);
var _sdl3_SDL_GetSystemRAM = Module['_sdl3_SDL_GetSystemRAM'] = () => (_sdl3_SDL_GetSystemRAM = Module['_sdl3_SDL_GetSystemRAM'] = wasmExports['sdl3_SDL_GetSystemRAM'])();
var _sdl3_SDL_GetSystemTheme = Module['_sdl3_SDL_GetSystemTheme'] = () => (_sdl3_SDL_GetSystemTheme = Module['_sdl3_SDL_GetSystemTheme'] = wasmExports['sdl3_SDL_GetSystemTheme'])();
var _sdl3_SDL_GetTLS = Module['_sdl3_SDL_GetTLS'] = (a0) => (_sdl3_SDL_GetTLS = Module['_sdl3_SDL_GetTLS'] = wasmExports['sdl3_SDL_GetTLS'])(a0);
var _sdl3_SDL_GetTextInputArea = Module['_sdl3_SDL_GetTextInputArea'] = (a0, a1, a2) => (_sdl3_SDL_GetTextInputArea = Module['_sdl3_SDL_GetTextInputArea'] = wasmExports['sdl3_SDL_GetTextInputArea'])(a0, a1, a2);
var _sdl3_SDL_GetTextureAlphaMod = Module['_sdl3_SDL_GetTextureAlphaMod'] = (a0, a1) => (_sdl3_SDL_GetTextureAlphaMod = Module['_sdl3_SDL_GetTextureAlphaMod'] = wasmExports['sdl3_SDL_GetTextureAlphaMod'])(a0, a1);
var _sdl3_SDL_GetTextureAlphaModFloat = Module['_sdl3_SDL_GetTextureAlphaModFloat'] = (a0, a1) => (_sdl3_SDL_GetTextureAlphaModFloat = Module['_sdl3_SDL_GetTextureAlphaModFloat'] = wasmExports['sdl3_SDL_GetTextureAlphaModFloat'])(a0, a1);
var _sdl3_SDL_GetTextureBlendMode = Module['_sdl3_SDL_GetTextureBlendMode'] = (a0, a1) => (_sdl3_SDL_GetTextureBlendMode = Module['_sdl3_SDL_GetTextureBlendMode'] = wasmExports['sdl3_SDL_GetTextureBlendMode'])(a0, a1);
var _sdl3_SDL_GetTextureColorMod = Module['_sdl3_SDL_GetTextureColorMod'] = (a0, a1, a2, a3) => (_sdl3_SDL_GetTextureColorMod = Module['_sdl3_SDL_GetTextureColorMod'] = wasmExports['sdl3_SDL_GetTextureColorMod'])(a0, a1, a2, a3);
var _sdl3_SDL_GetTextureColorModFloat = Module['_sdl3_SDL_GetTextureColorModFloat'] = (a0, a1, a2, a3) => (_sdl3_SDL_GetTextureColorModFloat = Module['_sdl3_SDL_GetTextureColorModFloat'] = wasmExports['sdl3_SDL_GetTextureColorModFloat'])(a0, a1, a2, a3);
var _sdl3_SDL_GetTextureProperties = Module['_sdl3_SDL_GetTextureProperties'] = (a0) => (_sdl3_SDL_GetTextureProperties = Module['_sdl3_SDL_GetTextureProperties'] = wasmExports['sdl3_SDL_GetTextureProperties'])(a0);
var _sdl3_SDL_GetTextureScaleMode = Module['_sdl3_SDL_GetTextureScaleMode'] = (a0, a1) => (_sdl3_SDL_GetTextureScaleMode = Module['_sdl3_SDL_GetTextureScaleMode'] = wasmExports['sdl3_SDL_GetTextureScaleMode'])(a0, a1);
var _sdl3_SDL_GetTextureSize = Module['_sdl3_SDL_GetTextureSize'] = (a0, a1, a2) => (_sdl3_SDL_GetTextureSize = Module['_sdl3_SDL_GetTextureSize'] = wasmExports['sdl3_SDL_GetTextureSize'])(a0, a1, a2);
var _sdl3_SDL_GetThreadID = Module['_sdl3_SDL_GetThreadID'] = (a0) => (_sdl3_SDL_GetThreadID = Module['_sdl3_SDL_GetThreadID'] = wasmExports['sdl3_SDL_GetThreadID'])(a0);
var _sdl3_SDL_GetThreadName = Module['_sdl3_SDL_GetThreadName'] = (a0) => (_sdl3_SDL_GetThreadName = Module['_sdl3_SDL_GetThreadName'] = wasmExports['sdl3_SDL_GetThreadName'])(a0);
var _sdl3_SDL_GetThreadState = Module['_sdl3_SDL_GetThreadState'] = (a0) => (_sdl3_SDL_GetThreadState = Module['_sdl3_SDL_GetThreadState'] = wasmExports['sdl3_SDL_GetThreadState'])(a0);
var _sdl3_SDL_GetTicks = Module['_sdl3_SDL_GetTicks'] = () => (_sdl3_SDL_GetTicks = Module['_sdl3_SDL_GetTicks'] = wasmExports['sdl3_SDL_GetTicks'])();
var _sdl3_SDL_GetTicksNS = Module['_sdl3_SDL_GetTicksNS'] = () => (_sdl3_SDL_GetTicksNS = Module['_sdl3_SDL_GetTicksNS'] = wasmExports['sdl3_SDL_GetTicksNS'])();
var _sdl3_SDL_GetTouchDeviceName = Module['_sdl3_SDL_GetTouchDeviceName'] = (a0) => (_sdl3_SDL_GetTouchDeviceName = Module['_sdl3_SDL_GetTouchDeviceName'] = wasmExports['sdl3_SDL_GetTouchDeviceName'])(a0);
var _sdl3_SDL_GetTouchDeviceType = Module['_sdl3_SDL_GetTouchDeviceType'] = (a0) => (_sdl3_SDL_GetTouchDeviceType = Module['_sdl3_SDL_GetTouchDeviceType'] = wasmExports['sdl3_SDL_GetTouchDeviceType'])(a0);
var _sdl3_SDL_GetTouchDevices = Module['_sdl3_SDL_GetTouchDevices'] = (a0) => (_sdl3_SDL_GetTouchDevices = Module['_sdl3_SDL_GetTouchDevices'] = wasmExports['sdl3_SDL_GetTouchDevices'])(a0);
var _sdl3_SDL_GetTouchFingers = Module['_sdl3_SDL_GetTouchFingers'] = (a0, a1) => (_sdl3_SDL_GetTouchFingers = Module['_sdl3_SDL_GetTouchFingers'] = wasmExports['sdl3_SDL_GetTouchFingers'])(a0, a1);
var _sdl3_SDL_GetTrayEntries = Module['_sdl3_SDL_GetTrayEntries'] = (a0, a1) => (_sdl3_SDL_GetTrayEntries = Module['_sdl3_SDL_GetTrayEntries'] = wasmExports['sdl3_SDL_GetTrayEntries'])(a0, a1);
var _sdl3_SDL_GetTrayEntryChecked = Module['_sdl3_SDL_GetTrayEntryChecked'] = (a0) => (_sdl3_SDL_GetTrayEntryChecked = Module['_sdl3_SDL_GetTrayEntryChecked'] = wasmExports['sdl3_SDL_GetTrayEntryChecked'])(a0);
var _sdl3_SDL_GetTrayEntryEnabled = Module['_sdl3_SDL_GetTrayEntryEnabled'] = (a0) => (_sdl3_SDL_GetTrayEntryEnabled = Module['_sdl3_SDL_GetTrayEntryEnabled'] = wasmExports['sdl3_SDL_GetTrayEntryEnabled'])(a0);
var _sdl3_SDL_GetTrayEntryLabel = Module['_sdl3_SDL_GetTrayEntryLabel'] = (a0) => (_sdl3_SDL_GetTrayEntryLabel = Module['_sdl3_SDL_GetTrayEntryLabel'] = wasmExports['sdl3_SDL_GetTrayEntryLabel'])(a0);
var _sdl3_SDL_GetTrayEntryParent = Module['_sdl3_SDL_GetTrayEntryParent'] = (a0) => (_sdl3_SDL_GetTrayEntryParent = Module['_sdl3_SDL_GetTrayEntryParent'] = wasmExports['sdl3_SDL_GetTrayEntryParent'])(a0);
var _sdl3_SDL_GetTrayMenu = Module['_sdl3_SDL_GetTrayMenu'] = (a0) => (_sdl3_SDL_GetTrayMenu = Module['_sdl3_SDL_GetTrayMenu'] = wasmExports['sdl3_SDL_GetTrayMenu'])(a0);
var _sdl3_SDL_GetTrayMenuParentEntry = Module['_sdl3_SDL_GetTrayMenuParentEntry'] = (a0) => (_sdl3_SDL_GetTrayMenuParentEntry = Module['_sdl3_SDL_GetTrayMenuParentEntry'] = wasmExports['sdl3_SDL_GetTrayMenuParentEntry'])(a0);
var _sdl3_SDL_GetTrayMenuParentTray = Module['_sdl3_SDL_GetTrayMenuParentTray'] = (a0) => (_sdl3_SDL_GetTrayMenuParentTray = Module['_sdl3_SDL_GetTrayMenuParentTray'] = wasmExports['sdl3_SDL_GetTrayMenuParentTray'])(a0);
var _sdl3_SDL_GetTraySubmenu = Module['_sdl3_SDL_GetTraySubmenu'] = (a0) => (_sdl3_SDL_GetTraySubmenu = Module['_sdl3_SDL_GetTraySubmenu'] = wasmExports['sdl3_SDL_GetTraySubmenu'])(a0);
var _sdl3_SDL_GetUserFolder = Module['_sdl3_SDL_GetUserFolder'] = (a0) => (_sdl3_SDL_GetUserFolder = Module['_sdl3_SDL_GetUserFolder'] = wasmExports['sdl3_SDL_GetUserFolder'])(a0);
var _sdl3_SDL_GetVersion = Module['_sdl3_SDL_GetVersion'] = () => (_sdl3_SDL_GetVersion = Module['_sdl3_SDL_GetVersion'] = wasmExports['sdl3_SDL_GetVersion'])();
var _sdl3_SDL_GetVideoDriver = Module['_sdl3_SDL_GetVideoDriver'] = (a0) => (_sdl3_SDL_GetVideoDriver = Module['_sdl3_SDL_GetVideoDriver'] = wasmExports['sdl3_SDL_GetVideoDriver'])(a0);
var _sdl3_SDL_GetWindowAspectRatio = Module['_sdl3_SDL_GetWindowAspectRatio'] = (a0, a1, a2) => (_sdl3_SDL_GetWindowAspectRatio = Module['_sdl3_SDL_GetWindowAspectRatio'] = wasmExports['sdl3_SDL_GetWindowAspectRatio'])(a0, a1, a2);
var _sdl3_SDL_GetWindowBordersSize = Module['_sdl3_SDL_GetWindowBordersSize'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_GetWindowBordersSize = Module['_sdl3_SDL_GetWindowBordersSize'] = wasmExports['sdl3_SDL_GetWindowBordersSize'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_GetWindowFlags = Module['_sdl3_SDL_GetWindowFlags'] = (a0) => (_sdl3_SDL_GetWindowFlags = Module['_sdl3_SDL_GetWindowFlags'] = wasmExports['sdl3_SDL_GetWindowFlags'])(a0);
var _sdl3_SDL_GetWindowFromEvent = Module['_sdl3_SDL_GetWindowFromEvent'] = (a0) => (_sdl3_SDL_GetWindowFromEvent = Module['_sdl3_SDL_GetWindowFromEvent'] = wasmExports['sdl3_SDL_GetWindowFromEvent'])(a0);
var _sdl3_SDL_GetWindowFromID = Module['_sdl3_SDL_GetWindowFromID'] = (a0) => (_sdl3_SDL_GetWindowFromID = Module['_sdl3_SDL_GetWindowFromID'] = wasmExports['sdl3_SDL_GetWindowFromID'])(a0);
var _sdl3_SDL_GetWindowFullscreenMode = Module['_sdl3_SDL_GetWindowFullscreenMode'] = (a0) => (_sdl3_SDL_GetWindowFullscreenMode = Module['_sdl3_SDL_GetWindowFullscreenMode'] = wasmExports['sdl3_SDL_GetWindowFullscreenMode'])(a0);
var _sdl3_SDL_GetWindowICCProfile = Module['_sdl3_SDL_GetWindowICCProfile'] = (a0, a1) => (_sdl3_SDL_GetWindowICCProfile = Module['_sdl3_SDL_GetWindowICCProfile'] = wasmExports['sdl3_SDL_GetWindowICCProfile'])(a0, a1);
var _sdl3_SDL_GetWindowID = Module['_sdl3_SDL_GetWindowID'] = (a0) => (_sdl3_SDL_GetWindowID = Module['_sdl3_SDL_GetWindowID'] = wasmExports['sdl3_SDL_GetWindowID'])(a0);
var _sdl3_SDL_GetWindowKeyboardGrab = Module['_sdl3_SDL_GetWindowKeyboardGrab'] = (a0) => (_sdl3_SDL_GetWindowKeyboardGrab = Module['_sdl3_SDL_GetWindowKeyboardGrab'] = wasmExports['sdl3_SDL_GetWindowKeyboardGrab'])(a0);
var _sdl3_SDL_GetWindowMaximumSize = Module['_sdl3_SDL_GetWindowMaximumSize'] = (a0, a1, a2) => (_sdl3_SDL_GetWindowMaximumSize = Module['_sdl3_SDL_GetWindowMaximumSize'] = wasmExports['sdl3_SDL_GetWindowMaximumSize'])(a0, a1, a2);
var _sdl3_SDL_GetWindowMinimumSize = Module['_sdl3_SDL_GetWindowMinimumSize'] = (a0, a1, a2) => (_sdl3_SDL_GetWindowMinimumSize = Module['_sdl3_SDL_GetWindowMinimumSize'] = wasmExports['sdl3_SDL_GetWindowMinimumSize'])(a0, a1, a2);
var _sdl3_SDL_GetWindowMouseGrab = Module['_sdl3_SDL_GetWindowMouseGrab'] = (a0) => (_sdl3_SDL_GetWindowMouseGrab = Module['_sdl3_SDL_GetWindowMouseGrab'] = wasmExports['sdl3_SDL_GetWindowMouseGrab'])(a0);
var _sdl3_SDL_GetWindowMouseRect = Module['_sdl3_SDL_GetWindowMouseRect'] = (a0) => (_sdl3_SDL_GetWindowMouseRect = Module['_sdl3_SDL_GetWindowMouseRect'] = wasmExports['sdl3_SDL_GetWindowMouseRect'])(a0);
var _sdl3_SDL_GetWindowOpacity = Module['_sdl3_SDL_GetWindowOpacity'] = (a0) => (_sdl3_SDL_GetWindowOpacity = Module['_sdl3_SDL_GetWindowOpacity'] = wasmExports['sdl3_SDL_GetWindowOpacity'])(a0);
var _sdl3_SDL_GetWindowParent = Module['_sdl3_SDL_GetWindowParent'] = (a0) => (_sdl3_SDL_GetWindowParent = Module['_sdl3_SDL_GetWindowParent'] = wasmExports['sdl3_SDL_GetWindowParent'])(a0);
var _sdl3_SDL_GetWindowPixelDensity = Module['_sdl3_SDL_GetWindowPixelDensity'] = (a0) => (_sdl3_SDL_GetWindowPixelDensity = Module['_sdl3_SDL_GetWindowPixelDensity'] = wasmExports['sdl3_SDL_GetWindowPixelDensity'])(a0);
var _sdl3_SDL_GetWindowPixelFormat = Module['_sdl3_SDL_GetWindowPixelFormat'] = (a0) => (_sdl3_SDL_GetWindowPixelFormat = Module['_sdl3_SDL_GetWindowPixelFormat'] = wasmExports['sdl3_SDL_GetWindowPixelFormat'])(a0);
var _sdl3_SDL_GetWindowProperties = Module['_sdl3_SDL_GetWindowProperties'] = (a0) => (_sdl3_SDL_GetWindowProperties = Module['_sdl3_SDL_GetWindowProperties'] = wasmExports['sdl3_SDL_GetWindowProperties'])(a0);
var _sdl3_SDL_GetWindowRelativeMouseMode = Module['_sdl3_SDL_GetWindowRelativeMouseMode'] = (a0) => (_sdl3_SDL_GetWindowRelativeMouseMode = Module['_sdl3_SDL_GetWindowRelativeMouseMode'] = wasmExports['sdl3_SDL_GetWindowRelativeMouseMode'])(a0);
var _sdl3_SDL_GetWindowSafeArea = Module['_sdl3_SDL_GetWindowSafeArea'] = (a0, a1) => (_sdl3_SDL_GetWindowSafeArea = Module['_sdl3_SDL_GetWindowSafeArea'] = wasmExports['sdl3_SDL_GetWindowSafeArea'])(a0, a1);
var _sdl3_SDL_GetWindowSize = Module['_sdl3_SDL_GetWindowSize'] = (a0, a1, a2) => (_sdl3_SDL_GetWindowSize = Module['_sdl3_SDL_GetWindowSize'] = wasmExports['sdl3_SDL_GetWindowSize'])(a0, a1, a2);
var _sdl3_SDL_GetWindowSizeInPixels = Module['_sdl3_SDL_GetWindowSizeInPixels'] = (a0, a1, a2) => (_sdl3_SDL_GetWindowSizeInPixels = Module['_sdl3_SDL_GetWindowSizeInPixels'] = wasmExports['sdl3_SDL_GetWindowSizeInPixels'])(a0, a1, a2);
var _sdl3_SDL_GetWindowSurface = Module['_sdl3_SDL_GetWindowSurface'] = (a0) => (_sdl3_SDL_GetWindowSurface = Module['_sdl3_SDL_GetWindowSurface'] = wasmExports['sdl3_SDL_GetWindowSurface'])(a0);
var _sdl3_SDL_GetWindowSurfaceVSync = Module['_sdl3_SDL_GetWindowSurfaceVSync'] = (a0, a1) => (_sdl3_SDL_GetWindowSurfaceVSync = Module['_sdl3_SDL_GetWindowSurfaceVSync'] = wasmExports['sdl3_SDL_GetWindowSurfaceVSync'])(a0, a1);
var _sdl3_SDL_GetWindowTitle = Module['_sdl3_SDL_GetWindowTitle'] = (a0) => (_sdl3_SDL_GetWindowTitle = Module['_sdl3_SDL_GetWindowTitle'] = wasmExports['sdl3_SDL_GetWindowTitle'])(a0);
var _sdl3_SDL_GetWindows = Module['_sdl3_SDL_GetWindows'] = (a0) => (_sdl3_SDL_GetWindows = Module['_sdl3_SDL_GetWindows'] = wasmExports['sdl3_SDL_GetWindows'])(a0);
var _sdl3_SDL_GlobDirectory = Module['_sdl3_SDL_GlobDirectory'] = (a0, a1, a2, a3) => (_sdl3_SDL_GlobDirectory = Module['_sdl3_SDL_GlobDirectory'] = wasmExports['sdl3_SDL_GlobDirectory'])(a0, a1, a2, a3);
var _sdl3_SDL_GlobStorageDirectory = Module['_sdl3_SDL_GlobStorageDirectory'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_GlobStorageDirectory = Module['_sdl3_SDL_GlobStorageDirectory'] = wasmExports['sdl3_SDL_GlobStorageDirectory'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_HapticEffectSupported = Module['_sdl3_SDL_HapticEffectSupported'] = (a0, a1) => (_sdl3_SDL_HapticEffectSupported = Module['_sdl3_SDL_HapticEffectSupported'] = wasmExports['sdl3_SDL_HapticEffectSupported'])(a0, a1);
var _sdl3_SDL_HapticRumbleSupported = Module['_sdl3_SDL_HapticRumbleSupported'] = (a0) => (_sdl3_SDL_HapticRumbleSupported = Module['_sdl3_SDL_HapticRumbleSupported'] = wasmExports['sdl3_SDL_HapticRumbleSupported'])(a0);
var _sdl3_SDL_HasARMSIMD = Module['_sdl3_SDL_HasARMSIMD'] = () => (_sdl3_SDL_HasARMSIMD = Module['_sdl3_SDL_HasARMSIMD'] = wasmExports['sdl3_SDL_HasARMSIMD'])();
var _sdl3_SDL_HasAVX = Module['_sdl3_SDL_HasAVX'] = () => (_sdl3_SDL_HasAVX = Module['_sdl3_SDL_HasAVX'] = wasmExports['sdl3_SDL_HasAVX'])();
var _sdl3_SDL_HasAVX2 = Module['_sdl3_SDL_HasAVX2'] = () => (_sdl3_SDL_HasAVX2 = Module['_sdl3_SDL_HasAVX2'] = wasmExports['sdl3_SDL_HasAVX2'])();
var _sdl3_SDL_HasAVX512F = Module['_sdl3_SDL_HasAVX512F'] = () => (_sdl3_SDL_HasAVX512F = Module['_sdl3_SDL_HasAVX512F'] = wasmExports['sdl3_SDL_HasAVX512F'])();
var _sdl3_SDL_HasAltiVec = Module['_sdl3_SDL_HasAltiVec'] = () => (_sdl3_SDL_HasAltiVec = Module['_sdl3_SDL_HasAltiVec'] = wasmExports['sdl3_SDL_HasAltiVec'])();
var _sdl3_SDL_HasClipboardData = Module['_sdl3_SDL_HasClipboardData'] = (a0) => (_sdl3_SDL_HasClipboardData = Module['_sdl3_SDL_HasClipboardData'] = wasmExports['sdl3_SDL_HasClipboardData'])(a0);
var _sdl3_SDL_HasClipboardText = Module['_sdl3_SDL_HasClipboardText'] = () => (_sdl3_SDL_HasClipboardText = Module['_sdl3_SDL_HasClipboardText'] = wasmExports['sdl3_SDL_HasClipboardText'])();
var _sdl3_SDL_HasEvent = Module['_sdl3_SDL_HasEvent'] = (a0) => (_sdl3_SDL_HasEvent = Module['_sdl3_SDL_HasEvent'] = wasmExports['sdl3_SDL_HasEvent'])(a0);
var _sdl3_SDL_HasEvents = Module['_sdl3_SDL_HasEvents'] = (a0, a1) => (_sdl3_SDL_HasEvents = Module['_sdl3_SDL_HasEvents'] = wasmExports['sdl3_SDL_HasEvents'])(a0, a1);
var _sdl3_SDL_HasGamepad = Module['_sdl3_SDL_HasGamepad'] = () => (_sdl3_SDL_HasGamepad = Module['_sdl3_SDL_HasGamepad'] = wasmExports['sdl3_SDL_HasGamepad'])();
var _sdl3_SDL_HasJoystick = Module['_sdl3_SDL_HasJoystick'] = () => (_sdl3_SDL_HasJoystick = Module['_sdl3_SDL_HasJoystick'] = wasmExports['sdl3_SDL_HasJoystick'])();
var _sdl3_SDL_HasKeyboard = Module['_sdl3_SDL_HasKeyboard'] = () => (_sdl3_SDL_HasKeyboard = Module['_sdl3_SDL_HasKeyboard'] = wasmExports['sdl3_SDL_HasKeyboard'])();
var _sdl3_SDL_HasLASX = Module['_sdl3_SDL_HasLASX'] = () => (_sdl3_SDL_HasLASX = Module['_sdl3_SDL_HasLASX'] = wasmExports['sdl3_SDL_HasLASX'])();
var _sdl3_SDL_HasLSX = Module['_sdl3_SDL_HasLSX'] = () => (_sdl3_SDL_HasLSX = Module['_sdl3_SDL_HasLSX'] = wasmExports['sdl3_SDL_HasLSX'])();
var _sdl3_SDL_HasMMX = Module['_sdl3_SDL_HasMMX'] = () => (_sdl3_SDL_HasMMX = Module['_sdl3_SDL_HasMMX'] = wasmExports['sdl3_SDL_HasMMX'])();
var _sdl3_SDL_HasMouse = Module['_sdl3_SDL_HasMouse'] = () => (_sdl3_SDL_HasMouse = Module['_sdl3_SDL_HasMouse'] = wasmExports['sdl3_SDL_HasMouse'])();
var _sdl3_SDL_HasNEON = Module['_sdl3_SDL_HasNEON'] = () => (_sdl3_SDL_HasNEON = Module['_sdl3_SDL_HasNEON'] = wasmExports['sdl3_SDL_HasNEON'])();
var _sdl3_SDL_HasPrimarySelectionText = Module['_sdl3_SDL_HasPrimarySelectionText'] = () => (_sdl3_SDL_HasPrimarySelectionText = Module['_sdl3_SDL_HasPrimarySelectionText'] = wasmExports['sdl3_SDL_HasPrimarySelectionText'])();
var _sdl3_SDL_HasProperty = Module['_sdl3_SDL_HasProperty'] = (a0, a1) => (_sdl3_SDL_HasProperty = Module['_sdl3_SDL_HasProperty'] = wasmExports['sdl3_SDL_HasProperty'])(a0, a1);
var _sdl3_SDL_HasRectIntersection = Module['_sdl3_SDL_HasRectIntersection'] = (a0, a1) => (_sdl3_SDL_HasRectIntersection = Module['_sdl3_SDL_HasRectIntersection'] = wasmExports['sdl3_SDL_HasRectIntersection'])(a0, a1);
var _sdl3_SDL_HasRectIntersectionFloat = Module['_sdl3_SDL_HasRectIntersectionFloat'] = (a0, a1) => (_sdl3_SDL_HasRectIntersectionFloat = Module['_sdl3_SDL_HasRectIntersectionFloat'] = wasmExports['sdl3_SDL_HasRectIntersectionFloat'])(a0, a1);
var _sdl3_SDL_HasSSE = Module['_sdl3_SDL_HasSSE'] = () => (_sdl3_SDL_HasSSE = Module['_sdl3_SDL_HasSSE'] = wasmExports['sdl3_SDL_HasSSE'])();
var _sdl3_SDL_HasSSE2 = Module['_sdl3_SDL_HasSSE2'] = () => (_sdl3_SDL_HasSSE2 = Module['_sdl3_SDL_HasSSE2'] = wasmExports['sdl3_SDL_HasSSE2'])();
var _sdl3_SDL_HasSSE3 = Module['_sdl3_SDL_HasSSE3'] = () => (_sdl3_SDL_HasSSE3 = Module['_sdl3_SDL_HasSSE3'] = wasmExports['sdl3_SDL_HasSSE3'])();
var _sdl3_SDL_HasSSE41 = Module['_sdl3_SDL_HasSSE41'] = () => (_sdl3_SDL_HasSSE41 = Module['_sdl3_SDL_HasSSE41'] = wasmExports['sdl3_SDL_HasSSE41'])();
var _sdl3_SDL_HasSSE42 = Module['_sdl3_SDL_HasSSE42'] = () => (_sdl3_SDL_HasSSE42 = Module['_sdl3_SDL_HasSSE42'] = wasmExports['sdl3_SDL_HasSSE42'])();
var _sdl3_SDL_HasScreenKeyboardSupport = Module['_sdl3_SDL_HasScreenKeyboardSupport'] = () => (_sdl3_SDL_HasScreenKeyboardSupport = Module['_sdl3_SDL_HasScreenKeyboardSupport'] = wasmExports['sdl3_SDL_HasScreenKeyboardSupport'])();
var _sdl3_SDL_HideCursor = Module['_sdl3_SDL_HideCursor'] = () => (_sdl3_SDL_HideCursor = Module['_sdl3_SDL_HideCursor'] = wasmExports['sdl3_SDL_HideCursor'])();
var _sdl3_SDL_HideWindow = Module['_sdl3_SDL_HideWindow'] = (a0) => (_sdl3_SDL_HideWindow = Module['_sdl3_SDL_HideWindow'] = wasmExports['sdl3_SDL_HideWindow'])(a0);
var _sdl3_SDL_IOFromConstMem = Module['_sdl3_SDL_IOFromConstMem'] = (a0, a1) => (_sdl3_SDL_IOFromConstMem = Module['_sdl3_SDL_IOFromConstMem'] = wasmExports['sdl3_SDL_IOFromConstMem'])(a0, a1);
var _sdl3_SDL_IOFromDynamicMem = Module['_sdl3_SDL_IOFromDynamicMem'] = () => (_sdl3_SDL_IOFromDynamicMem = Module['_sdl3_SDL_IOFromDynamicMem'] = wasmExports['sdl3_SDL_IOFromDynamicMem'])();
var _sdl3_SDL_IOFromFile = Module['_sdl3_SDL_IOFromFile'] = (a0, a1) => (_sdl3_SDL_IOFromFile = Module['_sdl3_SDL_IOFromFile'] = wasmExports['sdl3_SDL_IOFromFile'])(a0, a1);
var _sdl3_SDL_IOFromMem = Module['_sdl3_SDL_IOFromMem'] = (a0, a1) => (_sdl3_SDL_IOFromMem = Module['_sdl3_SDL_IOFromMem'] = wasmExports['sdl3_SDL_IOFromMem'])(a0, a1);
var _sdl3_SDL_IOprintf = Module['_sdl3_SDL_IOprintf'] = (a0, a1) => (_sdl3_SDL_IOprintf = Module['_sdl3_SDL_IOprintf'] = wasmExports['sdl3_SDL_IOprintf'])(a0, a1);
var _sdl3_SDL_Init = Module['_sdl3_SDL_Init'] = (a0) => (_sdl3_SDL_Init = Module['_sdl3_SDL_Init'] = wasmExports['sdl3_SDL_Init'])(a0);
var _sdl3_SDL_InitHapticRumble = Module['_sdl3_SDL_InitHapticRumble'] = (a0) => (_sdl3_SDL_InitHapticRumble = Module['_sdl3_SDL_InitHapticRumble'] = wasmExports['sdl3_SDL_InitHapticRumble'])(a0);
var _sdl3_SDL_InitSubSystem = Module['_sdl3_SDL_InitSubSystem'] = (a0) => (_sdl3_SDL_InitSubSystem = Module['_sdl3_SDL_InitSubSystem'] = wasmExports['sdl3_SDL_InitSubSystem'])(a0);
var _sdl3_SDL_InsertGPUDebugLabel = Module['_sdl3_SDL_InsertGPUDebugLabel'] = (a0, a1) => (_sdl3_SDL_InsertGPUDebugLabel = Module['_sdl3_SDL_InsertGPUDebugLabel'] = wasmExports['sdl3_SDL_InsertGPUDebugLabel'])(a0, a1);
var _sdl3_SDL_InsertTrayEntryAt = Module['_sdl3_SDL_InsertTrayEntryAt'] = (a0, a1, a2, a3) => (_sdl3_SDL_InsertTrayEntryAt = Module['_sdl3_SDL_InsertTrayEntryAt'] = wasmExports['sdl3_SDL_InsertTrayEntryAt'])(a0, a1, a2, a3);
var _sdl3_SDL_IsAudioDevicePhysical = Module['_sdl3_SDL_IsAudioDevicePhysical'] = (a0) => (_sdl3_SDL_IsAudioDevicePhysical = Module['_sdl3_SDL_IsAudioDevicePhysical'] = wasmExports['sdl3_SDL_IsAudioDevicePhysical'])(a0);
var _sdl3_SDL_IsAudioDevicePlayback = Module['_sdl3_SDL_IsAudioDevicePlayback'] = (a0) => (_sdl3_SDL_IsAudioDevicePlayback = Module['_sdl3_SDL_IsAudioDevicePlayback'] = wasmExports['sdl3_SDL_IsAudioDevicePlayback'])(a0);
var _sdl3_SDL_IsGamepad = Module['_sdl3_SDL_IsGamepad'] = (a0) => (_sdl3_SDL_IsGamepad = Module['_sdl3_SDL_IsGamepad'] = wasmExports['sdl3_SDL_IsGamepad'])(a0);
var _sdl3_SDL_IsJoystickHaptic = Module['_sdl3_SDL_IsJoystickHaptic'] = (a0) => (_sdl3_SDL_IsJoystickHaptic = Module['_sdl3_SDL_IsJoystickHaptic'] = wasmExports['sdl3_SDL_IsJoystickHaptic'])(a0);
var _sdl3_SDL_IsJoystickVirtual = Module['_sdl3_SDL_IsJoystickVirtual'] = (a0) => (_sdl3_SDL_IsJoystickVirtual = Module['_sdl3_SDL_IsJoystickVirtual'] = wasmExports['sdl3_SDL_IsJoystickVirtual'])(a0);
var _sdl3_SDL_IsMainThread = Module['_sdl3_SDL_IsMainThread'] = () => (_sdl3_SDL_IsMainThread = Module['_sdl3_SDL_IsMainThread'] = wasmExports['sdl3_SDL_IsMainThread'])();
var _sdl3_SDL_IsMouseHaptic = Module['_sdl3_SDL_IsMouseHaptic'] = () => (_sdl3_SDL_IsMouseHaptic = Module['_sdl3_SDL_IsMouseHaptic'] = wasmExports['sdl3_SDL_IsMouseHaptic'])();
var _sdl3_SDL_IsTV = Module['_sdl3_SDL_IsTV'] = () => (_sdl3_SDL_IsTV = Module['_sdl3_SDL_IsTV'] = wasmExports['sdl3_SDL_IsTV'])();
var _sdl3_SDL_IsTablet = Module['_sdl3_SDL_IsTablet'] = () => (_sdl3_SDL_IsTablet = Module['_sdl3_SDL_IsTablet'] = wasmExports['sdl3_SDL_IsTablet'])();
var _sdl3_SDL_JoystickConnected = Module['_sdl3_SDL_JoystickConnected'] = (a0) => (_sdl3_SDL_JoystickConnected = Module['_sdl3_SDL_JoystickConnected'] = wasmExports['sdl3_SDL_JoystickConnected'])(a0);
var _sdl3_SDL_JoystickEventsEnabled = Module['_sdl3_SDL_JoystickEventsEnabled'] = () => (_sdl3_SDL_JoystickEventsEnabled = Module['_sdl3_SDL_JoystickEventsEnabled'] = wasmExports['sdl3_SDL_JoystickEventsEnabled'])();
var _sdl3_SDL_KillProcess = Module['_sdl3_SDL_KillProcess'] = (a0, a1) => (_sdl3_SDL_KillProcess = Module['_sdl3_SDL_KillProcess'] = wasmExports['sdl3_SDL_KillProcess'])(a0, a1);
var _sdl3_SDL_LoadBMP = Module['_sdl3_SDL_LoadBMP'] = (a0) => (_sdl3_SDL_LoadBMP = Module['_sdl3_SDL_LoadBMP'] = wasmExports['sdl3_SDL_LoadBMP'])(a0);
var _sdl3_SDL_LoadBMP_IO = Module['_sdl3_SDL_LoadBMP_IO'] = (a0, a1) => (_sdl3_SDL_LoadBMP_IO = Module['_sdl3_SDL_LoadBMP_IO'] = wasmExports['sdl3_SDL_LoadBMP_IO'])(a0, a1);
var _sdl3_SDL_LoadFile = Module['_sdl3_SDL_LoadFile'] = (a0, a1) => (_sdl3_SDL_LoadFile = Module['_sdl3_SDL_LoadFile'] = wasmExports['sdl3_SDL_LoadFile'])(a0, a1);
var _sdl3_SDL_LoadFileAsync = Module['_sdl3_SDL_LoadFileAsync'] = (a0, a1, a2) => (_sdl3_SDL_LoadFileAsync = Module['_sdl3_SDL_LoadFileAsync'] = wasmExports['sdl3_SDL_LoadFileAsync'])(a0, a1, a2);
var _sdl3_SDL_LoadFile_IO = Module['_sdl3_SDL_LoadFile_IO'] = (a0, a1, a2) => (_sdl3_SDL_LoadFile_IO = Module['_sdl3_SDL_LoadFile_IO'] = wasmExports['sdl3_SDL_LoadFile_IO'])(a0, a1, a2);
var _sdl3_SDL_LoadFunction = Module['_sdl3_SDL_LoadFunction'] = (a0, a1) => (_sdl3_SDL_LoadFunction = Module['_sdl3_SDL_LoadFunction'] = wasmExports['sdl3_SDL_LoadFunction'])(a0, a1);
var _sdl3_SDL_LoadObject = Module['_sdl3_SDL_LoadObject'] = (a0) => (_sdl3_SDL_LoadObject = Module['_sdl3_SDL_LoadObject'] = wasmExports['sdl3_SDL_LoadObject'])(a0);
var _sdl3_SDL_LoadWAV = Module['_sdl3_SDL_LoadWAV'] = (a0, a1, a2, a3) => (_sdl3_SDL_LoadWAV = Module['_sdl3_SDL_LoadWAV'] = wasmExports['sdl3_SDL_LoadWAV'])(a0, a1, a2, a3);
var _sdl3_SDL_LoadWAV_IO = Module['_sdl3_SDL_LoadWAV_IO'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_LoadWAV_IO = Module['_sdl3_SDL_LoadWAV_IO'] = wasmExports['sdl3_SDL_LoadWAV_IO'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_LockAudioStream = Module['_sdl3_SDL_LockAudioStream'] = (a0) => (_sdl3_SDL_LockAudioStream = Module['_sdl3_SDL_LockAudioStream'] = wasmExports['sdl3_SDL_LockAudioStream'])(a0);
var _sdl3_SDL_LockJoysticks = Module['_sdl3_SDL_LockJoysticks'] = () => (_sdl3_SDL_LockJoysticks = Module['_sdl3_SDL_LockJoysticks'] = wasmExports['sdl3_SDL_LockJoysticks'])();
var _sdl3_SDL_LockMutex = Module['_sdl3_SDL_LockMutex'] = (a0) => (_sdl3_SDL_LockMutex = Module['_sdl3_SDL_LockMutex'] = wasmExports['sdl3_SDL_LockMutex'])(a0);
var _sdl3_SDL_LockProperties = Module['_sdl3_SDL_LockProperties'] = (a0) => (_sdl3_SDL_LockProperties = Module['_sdl3_SDL_LockProperties'] = wasmExports['sdl3_SDL_LockProperties'])(a0);
var _sdl3_SDL_LockRWLockForReading = Module['_sdl3_SDL_LockRWLockForReading'] = (a0) => (_sdl3_SDL_LockRWLockForReading = Module['_sdl3_SDL_LockRWLockForReading'] = wasmExports['sdl3_SDL_LockRWLockForReading'])(a0);
var _sdl3_SDL_LockRWLockForWriting = Module['_sdl3_SDL_LockRWLockForWriting'] = (a0) => (_sdl3_SDL_LockRWLockForWriting = Module['_sdl3_SDL_LockRWLockForWriting'] = wasmExports['sdl3_SDL_LockRWLockForWriting'])(a0);
var _sdl3_SDL_LockSpinlock = Module['_sdl3_SDL_LockSpinlock'] = (a0) => (_sdl3_SDL_LockSpinlock = Module['_sdl3_SDL_LockSpinlock'] = wasmExports['sdl3_SDL_LockSpinlock'])(a0);
var _sdl3_SDL_LockSurface = Module['_sdl3_SDL_LockSurface'] = (a0) => (_sdl3_SDL_LockSurface = Module['_sdl3_SDL_LockSurface'] = wasmExports['sdl3_SDL_LockSurface'])(a0);
var _sdl3_SDL_LockTexture = Module['_sdl3_SDL_LockTexture'] = (a0, a1, a2, a3) => (_sdl3_SDL_LockTexture = Module['_sdl3_SDL_LockTexture'] = wasmExports['sdl3_SDL_LockTexture'])(a0, a1, a2, a3);
var _sdl3_SDL_LockTextureToSurface = Module['_sdl3_SDL_LockTextureToSurface'] = (a0, a1, a2) => (_sdl3_SDL_LockTextureToSurface = Module['_sdl3_SDL_LockTextureToSurface'] = wasmExports['sdl3_SDL_LockTextureToSurface'])(a0, a1, a2);
var _sdl3_SDL_Log = Module['_sdl3_SDL_Log'] = (a0) => (_sdl3_SDL_Log = Module['_sdl3_SDL_Log'] = wasmExports['sdl3_SDL_Log'])(a0);
var _sdl3_SDL_LogCritical = Module['_sdl3_SDL_LogCritical'] = (a0, a1) => (_sdl3_SDL_LogCritical = Module['_sdl3_SDL_LogCritical'] = wasmExports['sdl3_SDL_LogCritical'])(a0, a1);
var _sdl3_SDL_LogDebug = Module['_sdl3_SDL_LogDebug'] = (a0, a1) => (_sdl3_SDL_LogDebug = Module['_sdl3_SDL_LogDebug'] = wasmExports['sdl3_SDL_LogDebug'])(a0, a1);
var _sdl3_SDL_LogError = Module['_sdl3_SDL_LogError'] = (a0, a1) => (_sdl3_SDL_LogError = Module['_sdl3_SDL_LogError'] = wasmExports['sdl3_SDL_LogError'])(a0, a1);
var _sdl3_SDL_LogInfo = Module['_sdl3_SDL_LogInfo'] = (a0, a1) => (_sdl3_SDL_LogInfo = Module['_sdl3_SDL_LogInfo'] = wasmExports['sdl3_SDL_LogInfo'])(a0, a1);
var _sdl3_SDL_LogMessage = Module['_sdl3_SDL_LogMessage'] = (a0, a1, a2) => (_sdl3_SDL_LogMessage = Module['_sdl3_SDL_LogMessage'] = wasmExports['sdl3_SDL_LogMessage'])(a0, a1, a2);
var _sdl3_SDL_LogTrace = Module['_sdl3_SDL_LogTrace'] = (a0, a1) => (_sdl3_SDL_LogTrace = Module['_sdl3_SDL_LogTrace'] = wasmExports['sdl3_SDL_LogTrace'])(a0, a1);
var _sdl3_SDL_LogVerbose = Module['_sdl3_SDL_LogVerbose'] = (a0, a1) => (_sdl3_SDL_LogVerbose = Module['_sdl3_SDL_LogVerbose'] = wasmExports['sdl3_SDL_LogVerbose'])(a0, a1);
var _sdl3_SDL_LogWarn = Module['_sdl3_SDL_LogWarn'] = (a0, a1) => (_sdl3_SDL_LogWarn = Module['_sdl3_SDL_LogWarn'] = wasmExports['sdl3_SDL_LogWarn'])(a0, a1);
var _sdl3_SDL_MapGPUTransferBuffer = Module['_sdl3_SDL_MapGPUTransferBuffer'] = (a0, a1, a2) => (_sdl3_SDL_MapGPUTransferBuffer = Module['_sdl3_SDL_MapGPUTransferBuffer'] = wasmExports['sdl3_SDL_MapGPUTransferBuffer'])(a0, a1, a2);
var _sdl3_SDL_MapRGB = Module['_sdl3_SDL_MapRGB'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_MapRGB = Module['_sdl3_SDL_MapRGB'] = wasmExports['sdl3_SDL_MapRGB'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_MapRGBA = Module['_sdl3_SDL_MapRGBA'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_MapRGBA = Module['_sdl3_SDL_MapRGBA'] = wasmExports['sdl3_SDL_MapRGBA'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_MapSurfaceRGB = Module['_sdl3_SDL_MapSurfaceRGB'] = (a0, a1, a2, a3) => (_sdl3_SDL_MapSurfaceRGB = Module['_sdl3_SDL_MapSurfaceRGB'] = wasmExports['sdl3_SDL_MapSurfaceRGB'])(a0, a1, a2, a3);
var _sdl3_SDL_MapSurfaceRGBA = Module['_sdl3_SDL_MapSurfaceRGBA'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_MapSurfaceRGBA = Module['_sdl3_SDL_MapSurfaceRGBA'] = wasmExports['sdl3_SDL_MapSurfaceRGBA'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_MaximizeWindow = Module['_sdl3_SDL_MaximizeWindow'] = (a0) => (_sdl3_SDL_MaximizeWindow = Module['_sdl3_SDL_MaximizeWindow'] = wasmExports['sdl3_SDL_MaximizeWindow'])(a0);
var _sdl3_SDL_MemoryBarrierAcquireFunction = Module['_sdl3_SDL_MemoryBarrierAcquireFunction'] = () => (_sdl3_SDL_MemoryBarrierAcquireFunction = Module['_sdl3_SDL_MemoryBarrierAcquireFunction'] = wasmExports['sdl3_SDL_MemoryBarrierAcquireFunction'])();
var _sdl3_SDL_MemoryBarrierReleaseFunction = Module['_sdl3_SDL_MemoryBarrierReleaseFunction'] = () => (_sdl3_SDL_MemoryBarrierReleaseFunction = Module['_sdl3_SDL_MemoryBarrierReleaseFunction'] = wasmExports['sdl3_SDL_MemoryBarrierReleaseFunction'])();
var _sdl3_SDL_Metal_CreateView = Module['_sdl3_SDL_Metal_CreateView'] = (a0) => (_sdl3_SDL_Metal_CreateView = Module['_sdl3_SDL_Metal_CreateView'] = wasmExports['sdl3_SDL_Metal_CreateView'])(a0);
var _sdl3_SDL_Metal_DestroyView = Module['_sdl3_SDL_Metal_DestroyView'] = (a0) => (_sdl3_SDL_Metal_DestroyView = Module['_sdl3_SDL_Metal_DestroyView'] = wasmExports['sdl3_SDL_Metal_DestroyView'])(a0);
var _sdl3_SDL_Metal_GetLayer = Module['_sdl3_SDL_Metal_GetLayer'] = (a0) => (_sdl3_SDL_Metal_GetLayer = Module['_sdl3_SDL_Metal_GetLayer'] = wasmExports['sdl3_SDL_Metal_GetLayer'])(a0);
var _sdl3_SDL_MinimizeWindow = Module['_sdl3_SDL_MinimizeWindow'] = (a0) => (_sdl3_SDL_MinimizeWindow = Module['_sdl3_SDL_MinimizeWindow'] = wasmExports['sdl3_SDL_MinimizeWindow'])(a0);
var _sdl3_SDL_MixAudio = Module['_sdl3_SDL_MixAudio'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_MixAudio = Module['_sdl3_SDL_MixAudio'] = wasmExports['sdl3_SDL_MixAudio'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_OnApplicationDidEnterBackground = Module['_sdl3_SDL_OnApplicationDidEnterBackground'] = () => (_sdl3_SDL_OnApplicationDidEnterBackground = Module['_sdl3_SDL_OnApplicationDidEnterBackground'] = wasmExports['sdl3_SDL_OnApplicationDidEnterBackground'])();
var _sdl3_SDL_OnApplicationDidEnterForeground = Module['_sdl3_SDL_OnApplicationDidEnterForeground'] = () => (_sdl3_SDL_OnApplicationDidEnterForeground = Module['_sdl3_SDL_OnApplicationDidEnterForeground'] = wasmExports['sdl3_SDL_OnApplicationDidEnterForeground'])();
var _sdl3_SDL_OnApplicationDidReceiveMemoryWarning = Module['_sdl3_SDL_OnApplicationDidReceiveMemoryWarning'] = () => (_sdl3_SDL_OnApplicationDidReceiveMemoryWarning = Module['_sdl3_SDL_OnApplicationDidReceiveMemoryWarning'] = wasmExports['sdl3_SDL_OnApplicationDidReceiveMemoryWarning'])();
var _sdl3_SDL_OnApplicationWillEnterBackground = Module['_sdl3_SDL_OnApplicationWillEnterBackground'] = () => (_sdl3_SDL_OnApplicationWillEnterBackground = Module['_sdl3_SDL_OnApplicationWillEnterBackground'] = wasmExports['sdl3_SDL_OnApplicationWillEnterBackground'])();
var _sdl3_SDL_OnApplicationWillEnterForeground = Module['_sdl3_SDL_OnApplicationWillEnterForeground'] = () => (_sdl3_SDL_OnApplicationWillEnterForeground = Module['_sdl3_SDL_OnApplicationWillEnterForeground'] = wasmExports['sdl3_SDL_OnApplicationWillEnterForeground'])();
var _sdl3_SDL_OnApplicationWillTerminate = Module['_sdl3_SDL_OnApplicationWillTerminate'] = () => (_sdl3_SDL_OnApplicationWillTerminate = Module['_sdl3_SDL_OnApplicationWillTerminate'] = wasmExports['sdl3_SDL_OnApplicationWillTerminate'])();
var _sdl3_SDL_OpenAudioDevice = Module['_sdl3_SDL_OpenAudioDevice'] = (a0, a1) => (_sdl3_SDL_OpenAudioDevice = Module['_sdl3_SDL_OpenAudioDevice'] = wasmExports['sdl3_SDL_OpenAudioDevice'])(a0, a1);
var _sdl3_SDL_OpenAudioDeviceStream = Module['_sdl3_SDL_OpenAudioDeviceStream'] = (a0, a1, a2, a3) => (_sdl3_SDL_OpenAudioDeviceStream = Module['_sdl3_SDL_OpenAudioDeviceStream'] = wasmExports['sdl3_SDL_OpenAudioDeviceStream'])(a0, a1, a2, a3);
var _sdl3_SDL_OpenCamera = Module['_sdl3_SDL_OpenCamera'] = (a0, a1) => (_sdl3_SDL_OpenCamera = Module['_sdl3_SDL_OpenCamera'] = wasmExports['sdl3_SDL_OpenCamera'])(a0, a1);
var _sdl3_SDL_OpenFileStorage = Module['_sdl3_SDL_OpenFileStorage'] = (a0) => (_sdl3_SDL_OpenFileStorage = Module['_sdl3_SDL_OpenFileStorage'] = wasmExports['sdl3_SDL_OpenFileStorage'])(a0);
var _sdl3_SDL_OpenGamepad = Module['_sdl3_SDL_OpenGamepad'] = (a0) => (_sdl3_SDL_OpenGamepad = Module['_sdl3_SDL_OpenGamepad'] = wasmExports['sdl3_SDL_OpenGamepad'])(a0);
var _sdl3_SDL_OpenHaptic = Module['_sdl3_SDL_OpenHaptic'] = (a0) => (_sdl3_SDL_OpenHaptic = Module['_sdl3_SDL_OpenHaptic'] = wasmExports['sdl3_SDL_OpenHaptic'])(a0);
var _sdl3_SDL_OpenHapticFromJoystick = Module['_sdl3_SDL_OpenHapticFromJoystick'] = (a0) => (_sdl3_SDL_OpenHapticFromJoystick = Module['_sdl3_SDL_OpenHapticFromJoystick'] = wasmExports['sdl3_SDL_OpenHapticFromJoystick'])(a0);
var _sdl3_SDL_OpenHapticFromMouse = Module['_sdl3_SDL_OpenHapticFromMouse'] = () => (_sdl3_SDL_OpenHapticFromMouse = Module['_sdl3_SDL_OpenHapticFromMouse'] = wasmExports['sdl3_SDL_OpenHapticFromMouse'])();
var _sdl3_SDL_OpenIO = Module['_sdl3_SDL_OpenIO'] = (a0, a1) => (_sdl3_SDL_OpenIO = Module['_sdl3_SDL_OpenIO'] = wasmExports['sdl3_SDL_OpenIO'])(a0, a1);
var _sdl3_SDL_OpenJoystick = Module['_sdl3_SDL_OpenJoystick'] = (a0) => (_sdl3_SDL_OpenJoystick = Module['_sdl3_SDL_OpenJoystick'] = wasmExports['sdl3_SDL_OpenJoystick'])(a0);
var _sdl3_SDL_OpenSensor = Module['_sdl3_SDL_OpenSensor'] = (a0) => (_sdl3_SDL_OpenSensor = Module['_sdl3_SDL_OpenSensor'] = wasmExports['sdl3_SDL_OpenSensor'])(a0);
var _sdl3_SDL_OpenStorage = Module['_sdl3_SDL_OpenStorage'] = (a0, a1) => (_sdl3_SDL_OpenStorage = Module['_sdl3_SDL_OpenStorage'] = wasmExports['sdl3_SDL_OpenStorage'])(a0, a1);
var _sdl3_SDL_OpenTitleStorage = Module['_sdl3_SDL_OpenTitleStorage'] = (a0, a1) => (_sdl3_SDL_OpenTitleStorage = Module['_sdl3_SDL_OpenTitleStorage'] = wasmExports['sdl3_SDL_OpenTitleStorage'])(a0, a1);
var _sdl3_SDL_OpenURL = Module['_sdl3_SDL_OpenURL'] = (a0) => (_sdl3_SDL_OpenURL = Module['_sdl3_SDL_OpenURL'] = wasmExports['sdl3_SDL_OpenURL'])(a0);
var _sdl3_SDL_OpenUserStorage = Module['_sdl3_SDL_OpenUserStorage'] = (a0, a1, a2) => (_sdl3_SDL_OpenUserStorage = Module['_sdl3_SDL_OpenUserStorage'] = wasmExports['sdl3_SDL_OpenUserStorage'])(a0, a1, a2);
var _sdl3_SDL_OutOfMemory = Module['_sdl3_SDL_OutOfMemory'] = () => (_sdl3_SDL_OutOfMemory = Module['_sdl3_SDL_OutOfMemory'] = wasmExports['sdl3_SDL_OutOfMemory'])();
var _sdl3_SDL_PauseAudioDevice = Module['_sdl3_SDL_PauseAudioDevice'] = (a0) => (_sdl3_SDL_PauseAudioDevice = Module['_sdl3_SDL_PauseAudioDevice'] = wasmExports['sdl3_SDL_PauseAudioDevice'])(a0);
var _sdl3_SDL_PauseAudioStreamDevice = Module['_sdl3_SDL_PauseAudioStreamDevice'] = (a0) => (_sdl3_SDL_PauseAudioStreamDevice = Module['_sdl3_SDL_PauseAudioStreamDevice'] = wasmExports['sdl3_SDL_PauseAudioStreamDevice'])(a0);
var _sdl3_SDL_PauseHaptic = Module['_sdl3_SDL_PauseHaptic'] = (a0) => (_sdl3_SDL_PauseHaptic = Module['_sdl3_SDL_PauseHaptic'] = wasmExports['sdl3_SDL_PauseHaptic'])(a0);
var _sdl3_SDL_PeepEvents = Module['_sdl3_SDL_PeepEvents'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_PeepEvents = Module['_sdl3_SDL_PeepEvents'] = wasmExports['sdl3_SDL_PeepEvents'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_PlayHapticRumble = Module['_sdl3_SDL_PlayHapticRumble'] = (a0, a1, a2) => (_sdl3_SDL_PlayHapticRumble = Module['_sdl3_SDL_PlayHapticRumble'] = wasmExports['sdl3_SDL_PlayHapticRumble'])(a0, a1, a2);
var _sdl3_SDL_PollEvent = Module['_sdl3_SDL_PollEvent'] = (a0) => (_sdl3_SDL_PollEvent = Module['_sdl3_SDL_PollEvent'] = wasmExports['sdl3_SDL_PollEvent'])(a0);
var _sdl3_SDL_PopGPUDebugGroup = Module['_sdl3_SDL_PopGPUDebugGroup'] = (a0) => (_sdl3_SDL_PopGPUDebugGroup = Module['_sdl3_SDL_PopGPUDebugGroup'] = wasmExports['sdl3_SDL_PopGPUDebugGroup'])(a0);
var _sdl3_SDL_PremultiplyAlpha = Module['_sdl3_SDL_PremultiplyAlpha'] = (a0, a1, a2, a3, a4, a5, a6, a7, a8) => (_sdl3_SDL_PremultiplyAlpha = Module['_sdl3_SDL_PremultiplyAlpha'] = wasmExports['sdl3_SDL_PremultiplyAlpha'])(a0, a1, a2, a3, a4, a5, a6, a7, a8);
var _sdl3_SDL_PremultiplySurfaceAlpha = Module['_sdl3_SDL_PremultiplySurfaceAlpha'] = (a0, a1) => (_sdl3_SDL_PremultiplySurfaceAlpha = Module['_sdl3_SDL_PremultiplySurfaceAlpha'] = wasmExports['sdl3_SDL_PremultiplySurfaceAlpha'])(a0, a1);
var _sdl3_SDL_PumpEvents = Module['_sdl3_SDL_PumpEvents'] = () => (_sdl3_SDL_PumpEvents = Module['_sdl3_SDL_PumpEvents'] = wasmExports['sdl3_SDL_PumpEvents'])();
var _sdl3_SDL_PushEvent = Module['_sdl3_SDL_PushEvent'] = (a0) => (_sdl3_SDL_PushEvent = Module['_sdl3_SDL_PushEvent'] = wasmExports['sdl3_SDL_PushEvent'])(a0);
var _sdl3_SDL_PushGPUComputeUniformData = Module['_sdl3_SDL_PushGPUComputeUniformData'] = (a0, a1, a2, a3) => (_sdl3_SDL_PushGPUComputeUniformData = Module['_sdl3_SDL_PushGPUComputeUniformData'] = wasmExports['sdl3_SDL_PushGPUComputeUniformData'])(a0, a1, a2, a3);
var _sdl3_SDL_PushGPUDebugGroup = Module['_sdl3_SDL_PushGPUDebugGroup'] = (a0, a1) => (_sdl3_SDL_PushGPUDebugGroup = Module['_sdl3_SDL_PushGPUDebugGroup'] = wasmExports['sdl3_SDL_PushGPUDebugGroup'])(a0, a1);
var _sdl3_SDL_PushGPUFragmentUniformData = Module['_sdl3_SDL_PushGPUFragmentUniformData'] = (a0, a1, a2, a3) => (_sdl3_SDL_PushGPUFragmentUniformData = Module['_sdl3_SDL_PushGPUFragmentUniformData'] = wasmExports['sdl3_SDL_PushGPUFragmentUniformData'])(a0, a1, a2, a3);
var _sdl3_SDL_PushGPUVertexUniformData = Module['_sdl3_SDL_PushGPUVertexUniformData'] = (a0, a1, a2, a3) => (_sdl3_SDL_PushGPUVertexUniformData = Module['_sdl3_SDL_PushGPUVertexUniformData'] = wasmExports['sdl3_SDL_PushGPUVertexUniformData'])(a0, a1, a2, a3);
var _sdl3_SDL_PutAudioStreamData = Module['_sdl3_SDL_PutAudioStreamData'] = (a0, a1, a2) => (_sdl3_SDL_PutAudioStreamData = Module['_sdl3_SDL_PutAudioStreamData'] = wasmExports['sdl3_SDL_PutAudioStreamData'])(a0, a1, a2);
var _sdl3_SDL_QueryGPUFence = Module['_sdl3_SDL_QueryGPUFence'] = (a0, a1) => (_sdl3_SDL_QueryGPUFence = Module['_sdl3_SDL_QueryGPUFence'] = wasmExports['sdl3_SDL_QueryGPUFence'])(a0, a1);
var _sdl3_SDL_Quit = Module['_sdl3_SDL_Quit'] = () => (_sdl3_SDL_Quit = Module['_sdl3_SDL_Quit'] = wasmExports['sdl3_SDL_Quit'])();
var _sdl3_SDL_QuitSubSystem = Module['_sdl3_SDL_QuitSubSystem'] = (a0) => (_sdl3_SDL_QuitSubSystem = Module['_sdl3_SDL_QuitSubSystem'] = wasmExports['sdl3_SDL_QuitSubSystem'])(a0);
var _sdl3_SDL_RaiseWindow = Module['_sdl3_SDL_RaiseWindow'] = (a0) => (_sdl3_SDL_RaiseWindow = Module['_sdl3_SDL_RaiseWindow'] = wasmExports['sdl3_SDL_RaiseWindow'])(a0);
var _sdl3_SDL_ReadAsyncIO = Module['_sdl3_SDL_ReadAsyncIO'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_ReadAsyncIO = Module['_sdl3_SDL_ReadAsyncIO'] = wasmExports['sdl3_SDL_ReadAsyncIO'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_ReadIO = Module['_sdl3_SDL_ReadIO'] = (a0, a1, a2) => (_sdl3_SDL_ReadIO = Module['_sdl3_SDL_ReadIO'] = wasmExports['sdl3_SDL_ReadIO'])(a0, a1, a2);
var _sdl3_SDL_ReadProcess = Module['_sdl3_SDL_ReadProcess'] = (a0, a1, a2) => (_sdl3_SDL_ReadProcess = Module['_sdl3_SDL_ReadProcess'] = wasmExports['sdl3_SDL_ReadProcess'])(a0, a1, a2);
var _sdl3_SDL_ReadS16BE = Module['_sdl3_SDL_ReadS16BE'] = (a0, a1) => (_sdl3_SDL_ReadS16BE = Module['_sdl3_SDL_ReadS16BE'] = wasmExports['sdl3_SDL_ReadS16BE'])(a0, a1);
var _sdl3_SDL_ReadS16LE = Module['_sdl3_SDL_ReadS16LE'] = (a0, a1) => (_sdl3_SDL_ReadS16LE = Module['_sdl3_SDL_ReadS16LE'] = wasmExports['sdl3_SDL_ReadS16LE'])(a0, a1);
var _sdl3_SDL_ReadS32BE = Module['_sdl3_SDL_ReadS32BE'] = (a0, a1) => (_sdl3_SDL_ReadS32BE = Module['_sdl3_SDL_ReadS32BE'] = wasmExports['sdl3_SDL_ReadS32BE'])(a0, a1);
var _sdl3_SDL_ReadS32LE = Module['_sdl3_SDL_ReadS32LE'] = (a0, a1) => (_sdl3_SDL_ReadS32LE = Module['_sdl3_SDL_ReadS32LE'] = wasmExports['sdl3_SDL_ReadS32LE'])(a0, a1);
var _sdl3_SDL_ReadS64BE = Module['_sdl3_SDL_ReadS64BE'] = (a0, a1) => (_sdl3_SDL_ReadS64BE = Module['_sdl3_SDL_ReadS64BE'] = wasmExports['sdl3_SDL_ReadS64BE'])(a0, a1);
var _sdl3_SDL_ReadS64LE = Module['_sdl3_SDL_ReadS64LE'] = (a0, a1) => (_sdl3_SDL_ReadS64LE = Module['_sdl3_SDL_ReadS64LE'] = wasmExports['sdl3_SDL_ReadS64LE'])(a0, a1);
var _sdl3_SDL_ReadS8 = Module['_sdl3_SDL_ReadS8'] = (a0, a1) => (_sdl3_SDL_ReadS8 = Module['_sdl3_SDL_ReadS8'] = wasmExports['sdl3_SDL_ReadS8'])(a0, a1);
var _sdl3_SDL_ReadStorageFile = Module['_sdl3_SDL_ReadStorageFile'] = (a0, a1, a2, a3) => (_sdl3_SDL_ReadStorageFile = Module['_sdl3_SDL_ReadStorageFile'] = wasmExports['sdl3_SDL_ReadStorageFile'])(a0, a1, a2, a3);
var _sdl3_SDL_ReadSurfacePixel = Module['_sdl3_SDL_ReadSurfacePixel'] = (a0, a1, a2, a3, a4, a5, a6) => (_sdl3_SDL_ReadSurfacePixel = Module['_sdl3_SDL_ReadSurfacePixel'] = wasmExports['sdl3_SDL_ReadSurfacePixel'])(a0, a1, a2, a3, a4, a5, a6);
var _sdl3_SDL_ReadSurfacePixelFloat = Module['_sdl3_SDL_ReadSurfacePixelFloat'] = (a0, a1, a2, a3, a4, a5, a6) => (_sdl3_SDL_ReadSurfacePixelFloat = Module['_sdl3_SDL_ReadSurfacePixelFloat'] = wasmExports['sdl3_SDL_ReadSurfacePixelFloat'])(a0, a1, a2, a3, a4, a5, a6);
var _sdl3_SDL_ReadU16BE = Module['_sdl3_SDL_ReadU16BE'] = (a0, a1) => (_sdl3_SDL_ReadU16BE = Module['_sdl3_SDL_ReadU16BE'] = wasmExports['sdl3_SDL_ReadU16BE'])(a0, a1);
var _sdl3_SDL_ReadU16LE = Module['_sdl3_SDL_ReadU16LE'] = (a0, a1) => (_sdl3_SDL_ReadU16LE = Module['_sdl3_SDL_ReadU16LE'] = wasmExports['sdl3_SDL_ReadU16LE'])(a0, a1);
var _sdl3_SDL_ReadU32BE = Module['_sdl3_SDL_ReadU32BE'] = (a0, a1) => (_sdl3_SDL_ReadU32BE = Module['_sdl3_SDL_ReadU32BE'] = wasmExports['sdl3_SDL_ReadU32BE'])(a0, a1);
var _sdl3_SDL_ReadU32LE = Module['_sdl3_SDL_ReadU32LE'] = (a0, a1) => (_sdl3_SDL_ReadU32LE = Module['_sdl3_SDL_ReadU32LE'] = wasmExports['sdl3_SDL_ReadU32LE'])(a0, a1);
var _sdl3_SDL_ReadU64BE = Module['_sdl3_SDL_ReadU64BE'] = (a0, a1) => (_sdl3_SDL_ReadU64BE = Module['_sdl3_SDL_ReadU64BE'] = wasmExports['sdl3_SDL_ReadU64BE'])(a0, a1);
var _sdl3_SDL_ReadU64LE = Module['_sdl3_SDL_ReadU64LE'] = (a0, a1) => (_sdl3_SDL_ReadU64LE = Module['_sdl3_SDL_ReadU64LE'] = wasmExports['sdl3_SDL_ReadU64LE'])(a0, a1);
var _sdl3_SDL_ReadU8 = Module['_sdl3_SDL_ReadU8'] = (a0, a1) => (_sdl3_SDL_ReadU8 = Module['_sdl3_SDL_ReadU8'] = wasmExports['sdl3_SDL_ReadU8'])(a0, a1);
var _sdl3_SDL_RegisterEvents = Module['_sdl3_SDL_RegisterEvents'] = (a0) => (_sdl3_SDL_RegisterEvents = Module['_sdl3_SDL_RegisterEvents'] = wasmExports['sdl3_SDL_RegisterEvents'])(a0);
var _sdl3_SDL_ReleaseCameraFrame = Module['_sdl3_SDL_ReleaseCameraFrame'] = (a0, a1) => (_sdl3_SDL_ReleaseCameraFrame = Module['_sdl3_SDL_ReleaseCameraFrame'] = wasmExports['sdl3_SDL_ReleaseCameraFrame'])(a0, a1);
var _sdl3_SDL_ReleaseGPUBuffer = Module['_sdl3_SDL_ReleaseGPUBuffer'] = (a0, a1) => (_sdl3_SDL_ReleaseGPUBuffer = Module['_sdl3_SDL_ReleaseGPUBuffer'] = wasmExports['sdl3_SDL_ReleaseGPUBuffer'])(a0, a1);
var _sdl3_SDL_ReleaseGPUComputePipeline = Module['_sdl3_SDL_ReleaseGPUComputePipeline'] = (a0, a1) => (_sdl3_SDL_ReleaseGPUComputePipeline = Module['_sdl3_SDL_ReleaseGPUComputePipeline'] = wasmExports['sdl3_SDL_ReleaseGPUComputePipeline'])(a0, a1);
var _sdl3_SDL_ReleaseGPUFence = Module['_sdl3_SDL_ReleaseGPUFence'] = (a0, a1) => (_sdl3_SDL_ReleaseGPUFence = Module['_sdl3_SDL_ReleaseGPUFence'] = wasmExports['sdl3_SDL_ReleaseGPUFence'])(a0, a1);
var _sdl3_SDL_ReleaseGPUGraphicsPipeline = Module['_sdl3_SDL_ReleaseGPUGraphicsPipeline'] = (a0, a1) => (_sdl3_SDL_ReleaseGPUGraphicsPipeline = Module['_sdl3_SDL_ReleaseGPUGraphicsPipeline'] = wasmExports['sdl3_SDL_ReleaseGPUGraphicsPipeline'])(a0, a1);
var _sdl3_SDL_ReleaseGPUSampler = Module['_sdl3_SDL_ReleaseGPUSampler'] = (a0, a1) => (_sdl3_SDL_ReleaseGPUSampler = Module['_sdl3_SDL_ReleaseGPUSampler'] = wasmExports['sdl3_SDL_ReleaseGPUSampler'])(a0, a1);
var _sdl3_SDL_ReleaseGPUShader = Module['_sdl3_SDL_ReleaseGPUShader'] = (a0, a1) => (_sdl3_SDL_ReleaseGPUShader = Module['_sdl3_SDL_ReleaseGPUShader'] = wasmExports['sdl3_SDL_ReleaseGPUShader'])(a0, a1);
var _sdl3_SDL_ReleaseGPUTexture = Module['_sdl3_SDL_ReleaseGPUTexture'] = (a0, a1) => (_sdl3_SDL_ReleaseGPUTexture = Module['_sdl3_SDL_ReleaseGPUTexture'] = wasmExports['sdl3_SDL_ReleaseGPUTexture'])(a0, a1);
var _sdl3_SDL_ReleaseGPUTransferBuffer = Module['_sdl3_SDL_ReleaseGPUTransferBuffer'] = (a0, a1) => (_sdl3_SDL_ReleaseGPUTransferBuffer = Module['_sdl3_SDL_ReleaseGPUTransferBuffer'] = wasmExports['sdl3_SDL_ReleaseGPUTransferBuffer'])(a0, a1);
var _sdl3_SDL_ReleaseWindowFromGPUDevice = Module['_sdl3_SDL_ReleaseWindowFromGPUDevice'] = (a0, a1) => (_sdl3_SDL_ReleaseWindowFromGPUDevice = Module['_sdl3_SDL_ReleaseWindowFromGPUDevice'] = wasmExports['sdl3_SDL_ReleaseWindowFromGPUDevice'])(a0, a1);
var _sdl3_SDL_ReloadGamepadMappings = Module['_sdl3_SDL_ReloadGamepadMappings'] = () => (_sdl3_SDL_ReloadGamepadMappings = Module['_sdl3_SDL_ReloadGamepadMappings'] = wasmExports['sdl3_SDL_ReloadGamepadMappings'])();
var _sdl3_SDL_RemoveEventWatch = Module['_sdl3_SDL_RemoveEventWatch'] = (a0, a1) => (_sdl3_SDL_RemoveEventWatch = Module['_sdl3_SDL_RemoveEventWatch'] = wasmExports['sdl3_SDL_RemoveEventWatch'])(a0, a1);
var _sdl3_SDL_RemoveHintCallback = Module['_sdl3_SDL_RemoveHintCallback'] = (a0, a1, a2) => (_sdl3_SDL_RemoveHintCallback = Module['_sdl3_SDL_RemoveHintCallback'] = wasmExports['sdl3_SDL_RemoveHintCallback'])(a0, a1, a2);
var _sdl3_SDL_RemovePath = Module['_sdl3_SDL_RemovePath'] = (a0) => (_sdl3_SDL_RemovePath = Module['_sdl3_SDL_RemovePath'] = wasmExports['sdl3_SDL_RemovePath'])(a0);
var _sdl3_SDL_RemoveStoragePath = Module['_sdl3_SDL_RemoveStoragePath'] = (a0, a1) => (_sdl3_SDL_RemoveStoragePath = Module['_sdl3_SDL_RemoveStoragePath'] = wasmExports['sdl3_SDL_RemoveStoragePath'])(a0, a1);
var _sdl3_SDL_RemoveSurfaceAlternateImages = Module['_sdl3_SDL_RemoveSurfaceAlternateImages'] = (a0) => (_sdl3_SDL_RemoveSurfaceAlternateImages = Module['_sdl3_SDL_RemoveSurfaceAlternateImages'] = wasmExports['sdl3_SDL_RemoveSurfaceAlternateImages'])(a0);
var _sdl3_SDL_RemoveTimer = Module['_sdl3_SDL_RemoveTimer'] = (a0) => (_sdl3_SDL_RemoveTimer = Module['_sdl3_SDL_RemoveTimer'] = wasmExports['sdl3_SDL_RemoveTimer'])(a0);
var _sdl3_SDL_RemoveTrayEntry = Module['_sdl3_SDL_RemoveTrayEntry'] = (a0) => (_sdl3_SDL_RemoveTrayEntry = Module['_sdl3_SDL_RemoveTrayEntry'] = wasmExports['sdl3_SDL_RemoveTrayEntry'])(a0);
var _sdl3_SDL_RenamePath = Module['_sdl3_SDL_RenamePath'] = (a0, a1) => (_sdl3_SDL_RenamePath = Module['_sdl3_SDL_RenamePath'] = wasmExports['sdl3_SDL_RenamePath'])(a0, a1);
var _sdl3_SDL_RenameStoragePath = Module['_sdl3_SDL_RenameStoragePath'] = (a0, a1, a2) => (_sdl3_SDL_RenameStoragePath = Module['_sdl3_SDL_RenameStoragePath'] = wasmExports['sdl3_SDL_RenameStoragePath'])(a0, a1, a2);
var _sdl3_SDL_RenderClear = Module['_sdl3_SDL_RenderClear'] = (a0) => (_sdl3_SDL_RenderClear = Module['_sdl3_SDL_RenderClear'] = wasmExports['sdl3_SDL_RenderClear'])(a0);
var _sdl3_SDL_RenderClipEnabled = Module['_sdl3_SDL_RenderClipEnabled'] = (a0) => (_sdl3_SDL_RenderClipEnabled = Module['_sdl3_SDL_RenderClipEnabled'] = wasmExports['sdl3_SDL_RenderClipEnabled'])(a0);
var _sdl3_SDL_RenderCoordinatesFromWindow = Module['_sdl3_SDL_RenderCoordinatesFromWindow'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_RenderCoordinatesFromWindow = Module['_sdl3_SDL_RenderCoordinatesFromWindow'] = wasmExports['sdl3_SDL_RenderCoordinatesFromWindow'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_RenderCoordinatesToWindow = Module['_sdl3_SDL_RenderCoordinatesToWindow'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_RenderCoordinatesToWindow = Module['_sdl3_SDL_RenderCoordinatesToWindow'] = wasmExports['sdl3_SDL_RenderCoordinatesToWindow'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_RenderDebugText = Module['_sdl3_SDL_RenderDebugText'] = (a0, a1, a2, a3) => (_sdl3_SDL_RenderDebugText = Module['_sdl3_SDL_RenderDebugText'] = wasmExports['sdl3_SDL_RenderDebugText'])(a0, a1, a2, a3);
var _sdl3_SDL_RenderDebugTextFormat = Module['_sdl3_SDL_RenderDebugTextFormat'] = (a0, a1, a2, a3) => (_sdl3_SDL_RenderDebugTextFormat = Module['_sdl3_SDL_RenderDebugTextFormat'] = wasmExports['sdl3_SDL_RenderDebugTextFormat'])(a0, a1, a2, a3);
var _sdl3_SDL_RenderFillRect = Module['_sdl3_SDL_RenderFillRect'] = (a0, a1) => (_sdl3_SDL_RenderFillRect = Module['_sdl3_SDL_RenderFillRect'] = wasmExports['sdl3_SDL_RenderFillRect'])(a0, a1);
var _sdl3_SDL_RenderFillRects = Module['_sdl3_SDL_RenderFillRects'] = (a0, a1, a2) => (_sdl3_SDL_RenderFillRects = Module['_sdl3_SDL_RenderFillRects'] = wasmExports['sdl3_SDL_RenderFillRects'])(a0, a1, a2);
var _sdl3_SDL_RenderGeometry = Module['_sdl3_SDL_RenderGeometry'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_RenderGeometry = Module['_sdl3_SDL_RenderGeometry'] = wasmExports['sdl3_SDL_RenderGeometry'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_RenderGeometryRaw = Module['_sdl3_SDL_RenderGeometryRaw'] = (a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) => (_sdl3_SDL_RenderGeometryRaw = Module['_sdl3_SDL_RenderGeometryRaw'] = wasmExports['sdl3_SDL_RenderGeometryRaw'])(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11);
var _sdl3_SDL_RenderLine = Module['_sdl3_SDL_RenderLine'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_RenderLine = Module['_sdl3_SDL_RenderLine'] = wasmExports['sdl3_SDL_RenderLine'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_RenderLines = Module['_sdl3_SDL_RenderLines'] = (a0, a1, a2) => (_sdl3_SDL_RenderLines = Module['_sdl3_SDL_RenderLines'] = wasmExports['sdl3_SDL_RenderLines'])(a0, a1, a2);
var _sdl3_SDL_RenderPoint = Module['_sdl3_SDL_RenderPoint'] = (a0, a1, a2) => (_sdl3_SDL_RenderPoint = Module['_sdl3_SDL_RenderPoint'] = wasmExports['sdl3_SDL_RenderPoint'])(a0, a1, a2);
var _sdl3_SDL_RenderPoints = Module['_sdl3_SDL_RenderPoints'] = (a0, a1, a2) => (_sdl3_SDL_RenderPoints = Module['_sdl3_SDL_RenderPoints'] = wasmExports['sdl3_SDL_RenderPoints'])(a0, a1, a2);
var _sdl3_SDL_RenderPresent = Module['_sdl3_SDL_RenderPresent'] = (a0) => (_sdl3_SDL_RenderPresent = Module['_sdl3_SDL_RenderPresent'] = wasmExports['sdl3_SDL_RenderPresent'])(a0);
var _sdl3_SDL_RenderReadPixels = Module['_sdl3_SDL_RenderReadPixels'] = (a0, a1) => (_sdl3_SDL_RenderReadPixels = Module['_sdl3_SDL_RenderReadPixels'] = wasmExports['sdl3_SDL_RenderReadPixels'])(a0, a1);
var _sdl3_SDL_RenderRect = Module['_sdl3_SDL_RenderRect'] = (a0, a1) => (_sdl3_SDL_RenderRect = Module['_sdl3_SDL_RenderRect'] = wasmExports['sdl3_SDL_RenderRect'])(a0, a1);
var _sdl3_SDL_RenderRects = Module['_sdl3_SDL_RenderRects'] = (a0, a1, a2) => (_sdl3_SDL_RenderRects = Module['_sdl3_SDL_RenderRects'] = wasmExports['sdl3_SDL_RenderRects'])(a0, a1, a2);
var _sdl3_SDL_RenderTexture = Module['_sdl3_SDL_RenderTexture'] = (a0, a1, a2, a3) => (_sdl3_SDL_RenderTexture = Module['_sdl3_SDL_RenderTexture'] = wasmExports['sdl3_SDL_RenderTexture'])(a0, a1, a2, a3);
var _sdl3_SDL_RenderTexture9Grid = Module['_sdl3_SDL_RenderTexture9Grid'] = (a0, a1, a2, a3, a4, a5, a6, a7, a8) => (_sdl3_SDL_RenderTexture9Grid = Module['_sdl3_SDL_RenderTexture9Grid'] = wasmExports['sdl3_SDL_RenderTexture9Grid'])(a0, a1, a2, a3, a4, a5, a6, a7, a8);
var _sdl3_SDL_RenderTextureAffine = Module['_sdl3_SDL_RenderTextureAffine'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_RenderTextureAffine = Module['_sdl3_SDL_RenderTextureAffine'] = wasmExports['sdl3_SDL_RenderTextureAffine'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_RenderTextureRotated = Module['_sdl3_SDL_RenderTextureRotated'] = (a0, a1, a2, a3, a4, a5, a6) => (_sdl3_SDL_RenderTextureRotated = Module['_sdl3_SDL_RenderTextureRotated'] = wasmExports['sdl3_SDL_RenderTextureRotated'])(a0, a1, a2, a3, a4, a5, a6);
var _sdl3_SDL_RenderTextureTiled = Module['_sdl3_SDL_RenderTextureTiled'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_RenderTextureTiled = Module['_sdl3_SDL_RenderTextureTiled'] = wasmExports['sdl3_SDL_RenderTextureTiled'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_RenderViewportSet = Module['_sdl3_SDL_RenderViewportSet'] = (a0) => (_sdl3_SDL_RenderViewportSet = Module['_sdl3_SDL_RenderViewportSet'] = wasmExports['sdl3_SDL_RenderViewportSet'])(a0);
var _sdl3_SDL_ReportAssertion = Module['_sdl3_SDL_ReportAssertion'] = (a0, a1, a2, a3) => (_sdl3_SDL_ReportAssertion = Module['_sdl3_SDL_ReportAssertion'] = wasmExports['sdl3_SDL_ReportAssertion'])(a0, a1, a2, a3);
var _sdl3_SDL_ResetAssertionReport = Module['_sdl3_SDL_ResetAssertionReport'] = () => (_sdl3_SDL_ResetAssertionReport = Module['_sdl3_SDL_ResetAssertionReport'] = wasmExports['sdl3_SDL_ResetAssertionReport'])();
var _sdl3_SDL_ResetHint = Module['_sdl3_SDL_ResetHint'] = (a0) => (_sdl3_SDL_ResetHint = Module['_sdl3_SDL_ResetHint'] = wasmExports['sdl3_SDL_ResetHint'])(a0);
var _sdl3_SDL_ResetHints = Module['_sdl3_SDL_ResetHints'] = () => (_sdl3_SDL_ResetHints = Module['_sdl3_SDL_ResetHints'] = wasmExports['sdl3_SDL_ResetHints'])();
var _sdl3_SDL_ResetKeyboard = Module['_sdl3_SDL_ResetKeyboard'] = () => (_sdl3_SDL_ResetKeyboard = Module['_sdl3_SDL_ResetKeyboard'] = wasmExports['sdl3_SDL_ResetKeyboard'])();
var _sdl3_SDL_ResetLogPriorities = Module['_sdl3_SDL_ResetLogPriorities'] = () => (_sdl3_SDL_ResetLogPriorities = Module['_sdl3_SDL_ResetLogPriorities'] = wasmExports['sdl3_SDL_ResetLogPriorities'])();
var _sdl3_SDL_RestoreWindow = Module['_sdl3_SDL_RestoreWindow'] = (a0) => (_sdl3_SDL_RestoreWindow = Module['_sdl3_SDL_RestoreWindow'] = wasmExports['sdl3_SDL_RestoreWindow'])(a0);
var _sdl3_SDL_ResumeAudioDevice = Module['_sdl3_SDL_ResumeAudioDevice'] = (a0) => (_sdl3_SDL_ResumeAudioDevice = Module['_sdl3_SDL_ResumeAudioDevice'] = wasmExports['sdl3_SDL_ResumeAudioDevice'])(a0);
var _sdl3_SDL_ResumeAudioStreamDevice = Module['_sdl3_SDL_ResumeAudioStreamDevice'] = (a0) => (_sdl3_SDL_ResumeAudioStreamDevice = Module['_sdl3_SDL_ResumeAudioStreamDevice'] = wasmExports['sdl3_SDL_ResumeAudioStreamDevice'])(a0);
var _sdl3_SDL_ResumeHaptic = Module['_sdl3_SDL_ResumeHaptic'] = (a0) => (_sdl3_SDL_ResumeHaptic = Module['_sdl3_SDL_ResumeHaptic'] = wasmExports['sdl3_SDL_ResumeHaptic'])(a0);
var _sdl3_SDL_RumbleGamepad = Module['_sdl3_SDL_RumbleGamepad'] = (a0, a1, a2, a3) => (_sdl3_SDL_RumbleGamepad = Module['_sdl3_SDL_RumbleGamepad'] = wasmExports['sdl3_SDL_RumbleGamepad'])(a0, a1, a2, a3);
var _sdl3_SDL_RumbleGamepadTriggers = Module['_sdl3_SDL_RumbleGamepadTriggers'] = (a0, a1, a2, a3) => (_sdl3_SDL_RumbleGamepadTriggers = Module['_sdl3_SDL_RumbleGamepadTriggers'] = wasmExports['sdl3_SDL_RumbleGamepadTriggers'])(a0, a1, a2, a3);
var _sdl3_SDL_RumbleJoystick = Module['_sdl3_SDL_RumbleJoystick'] = (a0, a1, a2, a3) => (_sdl3_SDL_RumbleJoystick = Module['_sdl3_SDL_RumbleJoystick'] = wasmExports['sdl3_SDL_RumbleJoystick'])(a0, a1, a2, a3);
var _sdl3_SDL_RumbleJoystickTriggers = Module['_sdl3_SDL_RumbleJoystickTriggers'] = (a0, a1, a2, a3) => (_sdl3_SDL_RumbleJoystickTriggers = Module['_sdl3_SDL_RumbleJoystickTriggers'] = wasmExports['sdl3_SDL_RumbleJoystickTriggers'])(a0, a1, a2, a3);
var _sdl3_SDL_RunApp = Module['_sdl3_SDL_RunApp'] = (a0, a1, a2, a3) => (_sdl3_SDL_RunApp = Module['_sdl3_SDL_RunApp'] = wasmExports['sdl3_SDL_RunApp'])(a0, a1, a2, a3);
var _sdl3_SDL_RunHapticEffect = Module['_sdl3_SDL_RunHapticEffect'] = (a0, a1, a2) => (_sdl3_SDL_RunHapticEffect = Module['_sdl3_SDL_RunHapticEffect'] = wasmExports['sdl3_SDL_RunHapticEffect'])(a0, a1, a2);
var _sdl3_SDL_RunOnMainThread = Module['_sdl3_SDL_RunOnMainThread'] = (a0, a1, a2) => (_sdl3_SDL_RunOnMainThread = Module['_sdl3_SDL_RunOnMainThread'] = wasmExports['sdl3_SDL_RunOnMainThread'])(a0, a1, a2);
var _sdl3_SDL_SaveBMP = Module['_sdl3_SDL_SaveBMP'] = (a0, a1) => (_sdl3_SDL_SaveBMP = Module['_sdl3_SDL_SaveBMP'] = wasmExports['sdl3_SDL_SaveBMP'])(a0, a1);
var _sdl3_SDL_SaveBMP_IO = Module['_sdl3_SDL_SaveBMP_IO'] = (a0, a1, a2) => (_sdl3_SDL_SaveBMP_IO = Module['_sdl3_SDL_SaveBMP_IO'] = wasmExports['sdl3_SDL_SaveBMP_IO'])(a0, a1, a2);
var _sdl3_SDL_SaveFile = Module['_sdl3_SDL_SaveFile'] = (a0, a1, a2) => (_sdl3_SDL_SaveFile = Module['_sdl3_SDL_SaveFile'] = wasmExports['sdl3_SDL_SaveFile'])(a0, a1, a2);
var _sdl3_SDL_SaveFile_IO = Module['_sdl3_SDL_SaveFile_IO'] = (a0, a1, a2, a3) => (_sdl3_SDL_SaveFile_IO = Module['_sdl3_SDL_SaveFile_IO'] = wasmExports['sdl3_SDL_SaveFile_IO'])(a0, a1, a2, a3);
var _sdl3_SDL_ScaleSurface = Module['_sdl3_SDL_ScaleSurface'] = (a0, a1, a2, a3) => (_sdl3_SDL_ScaleSurface = Module['_sdl3_SDL_ScaleSurface'] = wasmExports['sdl3_SDL_ScaleSurface'])(a0, a1, a2, a3);
var _sdl3_SDL_ScreenKeyboardShown = Module['_sdl3_SDL_ScreenKeyboardShown'] = (a0) => (_sdl3_SDL_ScreenKeyboardShown = Module['_sdl3_SDL_ScreenKeyboardShown'] = wasmExports['sdl3_SDL_ScreenKeyboardShown'])(a0);
var _sdl3_SDL_ScreenSaverEnabled = Module['_sdl3_SDL_ScreenSaverEnabled'] = () => (_sdl3_SDL_ScreenSaverEnabled = Module['_sdl3_SDL_ScreenSaverEnabled'] = wasmExports['sdl3_SDL_ScreenSaverEnabled'])();
var _sdl3_SDL_SeekIO = Module['_sdl3_SDL_SeekIO'] = (a0, a1, a2) => (_sdl3_SDL_SeekIO = Module['_sdl3_SDL_SeekIO'] = wasmExports['sdl3_SDL_SeekIO'])(a0, a1, a2);
var _sdl3_SDL_SendGamepadEffect = Module['_sdl3_SDL_SendGamepadEffect'] = (a0, a1, a2) => (_sdl3_SDL_SendGamepadEffect = Module['_sdl3_SDL_SendGamepadEffect'] = wasmExports['sdl3_SDL_SendGamepadEffect'])(a0, a1, a2);
var _sdl3_SDL_SendJoystickEffect = Module['_sdl3_SDL_SendJoystickEffect'] = (a0, a1, a2) => (_sdl3_SDL_SendJoystickEffect = Module['_sdl3_SDL_SendJoystickEffect'] = wasmExports['sdl3_SDL_SendJoystickEffect'])(a0, a1, a2);
var _sdl3_SDL_SendJoystickVirtualSensorData = Module['_sdl3_SDL_SendJoystickVirtualSensorData'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_SendJoystickVirtualSensorData = Module['_sdl3_SDL_SendJoystickVirtualSensorData'] = wasmExports['sdl3_SDL_SendJoystickVirtualSensorData'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_SetAppMetadata = Module['_sdl3_SDL_SetAppMetadata'] = (a0, a1, a2) => (_sdl3_SDL_SetAppMetadata = Module['_sdl3_SDL_SetAppMetadata'] = wasmExports['sdl3_SDL_SetAppMetadata'])(a0, a1, a2);
var _sdl3_SDL_SetAppMetadataProperty = Module['_sdl3_SDL_SetAppMetadataProperty'] = (a0, a1) => (_sdl3_SDL_SetAppMetadataProperty = Module['_sdl3_SDL_SetAppMetadataProperty'] = wasmExports['sdl3_SDL_SetAppMetadataProperty'])(a0, a1);
var _sdl3_SDL_SetAssertionHandler = Module['_sdl3_SDL_SetAssertionHandler'] = (a0, a1) => (_sdl3_SDL_SetAssertionHandler = Module['_sdl3_SDL_SetAssertionHandler'] = wasmExports['sdl3_SDL_SetAssertionHandler'])(a0, a1);
var _sdl3_SDL_SetAtomicInt = Module['_sdl3_SDL_SetAtomicInt'] = (a0, a1) => (_sdl3_SDL_SetAtomicInt = Module['_sdl3_SDL_SetAtomicInt'] = wasmExports['sdl3_SDL_SetAtomicInt'])(a0, a1);
var _sdl3_SDL_SetAtomicPointer = Module['_sdl3_SDL_SetAtomicPointer'] = (a0, a1) => (_sdl3_SDL_SetAtomicPointer = Module['_sdl3_SDL_SetAtomicPointer'] = wasmExports['sdl3_SDL_SetAtomicPointer'])(a0, a1);
var _sdl3_SDL_SetAtomicU32 = Module['_sdl3_SDL_SetAtomicU32'] = (a0, a1) => (_sdl3_SDL_SetAtomicU32 = Module['_sdl3_SDL_SetAtomicU32'] = wasmExports['sdl3_SDL_SetAtomicU32'])(a0, a1);
var _sdl3_SDL_SetAudioDeviceGain = Module['_sdl3_SDL_SetAudioDeviceGain'] = (a0, a1) => (_sdl3_SDL_SetAudioDeviceGain = Module['_sdl3_SDL_SetAudioDeviceGain'] = wasmExports['sdl3_SDL_SetAudioDeviceGain'])(a0, a1);
var _sdl3_SDL_SetAudioPostmixCallback = Module['_sdl3_SDL_SetAudioPostmixCallback'] = (a0, a1, a2) => (_sdl3_SDL_SetAudioPostmixCallback = Module['_sdl3_SDL_SetAudioPostmixCallback'] = wasmExports['sdl3_SDL_SetAudioPostmixCallback'])(a0, a1, a2);
var _sdl3_SDL_SetAudioStreamFormat = Module['_sdl3_SDL_SetAudioStreamFormat'] = (a0, a1, a2) => (_sdl3_SDL_SetAudioStreamFormat = Module['_sdl3_SDL_SetAudioStreamFormat'] = wasmExports['sdl3_SDL_SetAudioStreamFormat'])(a0, a1, a2);
var _sdl3_SDL_SetAudioStreamFrequencyRatio = Module['_sdl3_SDL_SetAudioStreamFrequencyRatio'] = (a0, a1) => (_sdl3_SDL_SetAudioStreamFrequencyRatio = Module['_sdl3_SDL_SetAudioStreamFrequencyRatio'] = wasmExports['sdl3_SDL_SetAudioStreamFrequencyRatio'])(a0, a1);
var _sdl3_SDL_SetAudioStreamGain = Module['_sdl3_SDL_SetAudioStreamGain'] = (a0, a1) => (_sdl3_SDL_SetAudioStreamGain = Module['_sdl3_SDL_SetAudioStreamGain'] = wasmExports['sdl3_SDL_SetAudioStreamGain'])(a0, a1);
var _sdl3_SDL_SetAudioStreamGetCallback = Module['_sdl3_SDL_SetAudioStreamGetCallback'] = (a0, a1, a2) => (_sdl3_SDL_SetAudioStreamGetCallback = Module['_sdl3_SDL_SetAudioStreamGetCallback'] = wasmExports['sdl3_SDL_SetAudioStreamGetCallback'])(a0, a1, a2);
var _sdl3_SDL_SetAudioStreamInputChannelMap = Module['_sdl3_SDL_SetAudioStreamInputChannelMap'] = (a0, a1, a2) => (_sdl3_SDL_SetAudioStreamInputChannelMap = Module['_sdl3_SDL_SetAudioStreamInputChannelMap'] = wasmExports['sdl3_SDL_SetAudioStreamInputChannelMap'])(a0, a1, a2);
var _sdl3_SDL_SetAudioStreamOutputChannelMap = Module['_sdl3_SDL_SetAudioStreamOutputChannelMap'] = (a0, a1, a2) => (_sdl3_SDL_SetAudioStreamOutputChannelMap = Module['_sdl3_SDL_SetAudioStreamOutputChannelMap'] = wasmExports['sdl3_SDL_SetAudioStreamOutputChannelMap'])(a0, a1, a2);
var _sdl3_SDL_SetAudioStreamPutCallback = Module['_sdl3_SDL_SetAudioStreamPutCallback'] = (a0, a1, a2) => (_sdl3_SDL_SetAudioStreamPutCallback = Module['_sdl3_SDL_SetAudioStreamPutCallback'] = wasmExports['sdl3_SDL_SetAudioStreamPutCallback'])(a0, a1, a2);
var _sdl3_SDL_SetBooleanProperty = Module['_sdl3_SDL_SetBooleanProperty'] = (a0, a1, a2) => (_sdl3_SDL_SetBooleanProperty = Module['_sdl3_SDL_SetBooleanProperty'] = wasmExports['sdl3_SDL_SetBooleanProperty'])(a0, a1, a2);
var _sdl3_SDL_SetClipboardData = Module['_sdl3_SDL_SetClipboardData'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_SetClipboardData = Module['_sdl3_SDL_SetClipboardData'] = wasmExports['sdl3_SDL_SetClipboardData'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_SetClipboardText = Module['_sdl3_SDL_SetClipboardText'] = (a0) => (_sdl3_SDL_SetClipboardText = Module['_sdl3_SDL_SetClipboardText'] = wasmExports['sdl3_SDL_SetClipboardText'])(a0);
var _sdl3_SDL_SetCurrentThreadPriority = Module['_sdl3_SDL_SetCurrentThreadPriority'] = (a0) => (_sdl3_SDL_SetCurrentThreadPriority = Module['_sdl3_SDL_SetCurrentThreadPriority'] = wasmExports['sdl3_SDL_SetCurrentThreadPriority'])(a0);
var _sdl3_SDL_SetCursor = Module['_sdl3_SDL_SetCursor'] = (a0) => (_sdl3_SDL_SetCursor = Module['_sdl3_SDL_SetCursor'] = wasmExports['sdl3_SDL_SetCursor'])(a0);
var _sdl3_SDL_SetError = Module['_sdl3_SDL_SetError'] = (a0) => (_sdl3_SDL_SetError = Module['_sdl3_SDL_SetError'] = wasmExports['sdl3_SDL_SetError'])(a0);
var _sdl3_SDL_SetEventEnabled = Module['_sdl3_SDL_SetEventEnabled'] = (a0, a1) => (_sdl3_SDL_SetEventEnabled = Module['_sdl3_SDL_SetEventEnabled'] = wasmExports['sdl3_SDL_SetEventEnabled'])(a0, a1);
var _sdl3_SDL_SetEventFilter = Module['_sdl3_SDL_SetEventFilter'] = (a0, a1) => (_sdl3_SDL_SetEventFilter = Module['_sdl3_SDL_SetEventFilter'] = wasmExports['sdl3_SDL_SetEventFilter'])(a0, a1);
var _sdl3_SDL_SetFloatProperty = Module['_sdl3_SDL_SetFloatProperty'] = (a0, a1, a2) => (_sdl3_SDL_SetFloatProperty = Module['_sdl3_SDL_SetFloatProperty'] = wasmExports['sdl3_SDL_SetFloatProperty'])(a0, a1, a2);
var _sdl3_SDL_SetGPUAllowedFramesInFlight = Module['_sdl3_SDL_SetGPUAllowedFramesInFlight'] = (a0, a1) => (_sdl3_SDL_SetGPUAllowedFramesInFlight = Module['_sdl3_SDL_SetGPUAllowedFramesInFlight'] = wasmExports['sdl3_SDL_SetGPUAllowedFramesInFlight'])(a0, a1);
var _sdl3_SDL_SetGPUBlendConstants = Module['_sdl3_SDL_SetGPUBlendConstants'] = (a0, a1) => (_sdl3_SDL_SetGPUBlendConstants = Module['_sdl3_SDL_SetGPUBlendConstants'] = wasmExports['sdl3_SDL_SetGPUBlendConstants'])(a0, a1);
var _sdl3_SDL_SetGPUBufferName = Module['_sdl3_SDL_SetGPUBufferName'] = (a0, a1, a2) => (_sdl3_SDL_SetGPUBufferName = Module['_sdl3_SDL_SetGPUBufferName'] = wasmExports['sdl3_SDL_SetGPUBufferName'])(a0, a1, a2);
var _sdl3_SDL_SetGPUScissor = Module['_sdl3_SDL_SetGPUScissor'] = (a0, a1) => (_sdl3_SDL_SetGPUScissor = Module['_sdl3_SDL_SetGPUScissor'] = wasmExports['sdl3_SDL_SetGPUScissor'])(a0, a1);
var _sdl3_SDL_SetGPUStencilReference = Module['_sdl3_SDL_SetGPUStencilReference'] = (a0, a1) => (_sdl3_SDL_SetGPUStencilReference = Module['_sdl3_SDL_SetGPUStencilReference'] = wasmExports['sdl3_SDL_SetGPUStencilReference'])(a0, a1);
var _sdl3_SDL_SetGPUSwapchainParameters = Module['_sdl3_SDL_SetGPUSwapchainParameters'] = (a0, a1, a2, a3) => (_sdl3_SDL_SetGPUSwapchainParameters = Module['_sdl3_SDL_SetGPUSwapchainParameters'] = wasmExports['sdl3_SDL_SetGPUSwapchainParameters'])(a0, a1, a2, a3);
var _sdl3_SDL_SetGPUTextureName = Module['_sdl3_SDL_SetGPUTextureName'] = (a0, a1, a2) => (_sdl3_SDL_SetGPUTextureName = Module['_sdl3_SDL_SetGPUTextureName'] = wasmExports['sdl3_SDL_SetGPUTextureName'])(a0, a1, a2);
var _sdl3_SDL_SetGPUViewport = Module['_sdl3_SDL_SetGPUViewport'] = (a0, a1) => (_sdl3_SDL_SetGPUViewport = Module['_sdl3_SDL_SetGPUViewport'] = wasmExports['sdl3_SDL_SetGPUViewport'])(a0, a1);
var _sdl3_SDL_SetGamepadEventsEnabled = Module['_sdl3_SDL_SetGamepadEventsEnabled'] = (a0) => (_sdl3_SDL_SetGamepadEventsEnabled = Module['_sdl3_SDL_SetGamepadEventsEnabled'] = wasmExports['sdl3_SDL_SetGamepadEventsEnabled'])(a0);
var _sdl3_SDL_SetGamepadLED = Module['_sdl3_SDL_SetGamepadLED'] = (a0, a1, a2, a3) => (_sdl3_SDL_SetGamepadLED = Module['_sdl3_SDL_SetGamepadLED'] = wasmExports['sdl3_SDL_SetGamepadLED'])(a0, a1, a2, a3);
var _sdl3_SDL_SetGamepadMapping = Module['_sdl3_SDL_SetGamepadMapping'] = (a0, a1) => (_sdl3_SDL_SetGamepadMapping = Module['_sdl3_SDL_SetGamepadMapping'] = wasmExports['sdl3_SDL_SetGamepadMapping'])(a0, a1);
var _sdl3_SDL_SetGamepadPlayerIndex = Module['_sdl3_SDL_SetGamepadPlayerIndex'] = (a0, a1) => (_sdl3_SDL_SetGamepadPlayerIndex = Module['_sdl3_SDL_SetGamepadPlayerIndex'] = wasmExports['sdl3_SDL_SetGamepadPlayerIndex'])(a0, a1);
var _sdl3_SDL_SetGamepadSensorEnabled = Module['_sdl3_SDL_SetGamepadSensorEnabled'] = (a0, a1, a2) => (_sdl3_SDL_SetGamepadSensorEnabled = Module['_sdl3_SDL_SetGamepadSensorEnabled'] = wasmExports['sdl3_SDL_SetGamepadSensorEnabled'])(a0, a1, a2);
var _sdl3_SDL_SetHapticAutocenter = Module['_sdl3_SDL_SetHapticAutocenter'] = (a0, a1) => (_sdl3_SDL_SetHapticAutocenter = Module['_sdl3_SDL_SetHapticAutocenter'] = wasmExports['sdl3_SDL_SetHapticAutocenter'])(a0, a1);
var _sdl3_SDL_SetHapticGain = Module['_sdl3_SDL_SetHapticGain'] = (a0, a1) => (_sdl3_SDL_SetHapticGain = Module['_sdl3_SDL_SetHapticGain'] = wasmExports['sdl3_SDL_SetHapticGain'])(a0, a1);
var _sdl3_SDL_SetHint = Module['_sdl3_SDL_SetHint'] = (a0, a1) => (_sdl3_SDL_SetHint = Module['_sdl3_SDL_SetHint'] = wasmExports['sdl3_SDL_SetHint'])(a0, a1);
var _sdl3_SDL_SetHintWithPriority = Module['_sdl3_SDL_SetHintWithPriority'] = (a0, a1, a2) => (_sdl3_SDL_SetHintWithPriority = Module['_sdl3_SDL_SetHintWithPriority'] = wasmExports['sdl3_SDL_SetHintWithPriority'])(a0, a1, a2);
var _sdl3_SDL_SetInitialized = Module['_sdl3_SDL_SetInitialized'] = (a0, a1) => (_sdl3_SDL_SetInitialized = Module['_sdl3_SDL_SetInitialized'] = wasmExports['sdl3_SDL_SetInitialized'])(a0, a1);
var _sdl3_SDL_SetJoystickEventsEnabled = Module['_sdl3_SDL_SetJoystickEventsEnabled'] = (a0) => (_sdl3_SDL_SetJoystickEventsEnabled = Module['_sdl3_SDL_SetJoystickEventsEnabled'] = wasmExports['sdl3_SDL_SetJoystickEventsEnabled'])(a0);
var _sdl3_SDL_SetJoystickLED = Module['_sdl3_SDL_SetJoystickLED'] = (a0, a1, a2, a3) => (_sdl3_SDL_SetJoystickLED = Module['_sdl3_SDL_SetJoystickLED'] = wasmExports['sdl3_SDL_SetJoystickLED'])(a0, a1, a2, a3);
var _sdl3_SDL_SetJoystickPlayerIndex = Module['_sdl3_SDL_SetJoystickPlayerIndex'] = (a0, a1) => (_sdl3_SDL_SetJoystickPlayerIndex = Module['_sdl3_SDL_SetJoystickPlayerIndex'] = wasmExports['sdl3_SDL_SetJoystickPlayerIndex'])(a0, a1);
var _sdl3_SDL_SetJoystickVirtualAxis = Module['_sdl3_SDL_SetJoystickVirtualAxis'] = (a0, a1, a2) => (_sdl3_SDL_SetJoystickVirtualAxis = Module['_sdl3_SDL_SetJoystickVirtualAxis'] = wasmExports['sdl3_SDL_SetJoystickVirtualAxis'])(a0, a1, a2);
var _sdl3_SDL_SetJoystickVirtualBall = Module['_sdl3_SDL_SetJoystickVirtualBall'] = (a0, a1, a2, a3) => (_sdl3_SDL_SetJoystickVirtualBall = Module['_sdl3_SDL_SetJoystickVirtualBall'] = wasmExports['sdl3_SDL_SetJoystickVirtualBall'])(a0, a1, a2, a3);
var _sdl3_SDL_SetJoystickVirtualButton = Module['_sdl3_SDL_SetJoystickVirtualButton'] = (a0, a1, a2) => (_sdl3_SDL_SetJoystickVirtualButton = Module['_sdl3_SDL_SetJoystickVirtualButton'] = wasmExports['sdl3_SDL_SetJoystickVirtualButton'])(a0, a1, a2);
var _sdl3_SDL_SetJoystickVirtualHat = Module['_sdl3_SDL_SetJoystickVirtualHat'] = (a0, a1, a2) => (_sdl3_SDL_SetJoystickVirtualHat = Module['_sdl3_SDL_SetJoystickVirtualHat'] = wasmExports['sdl3_SDL_SetJoystickVirtualHat'])(a0, a1, a2);
var _sdl3_SDL_SetJoystickVirtualTouchpad = Module['_sdl3_SDL_SetJoystickVirtualTouchpad'] = (a0, a1, a2, a3, a4, a5, a6) => (_sdl3_SDL_SetJoystickVirtualTouchpad = Module['_sdl3_SDL_SetJoystickVirtualTouchpad'] = wasmExports['sdl3_SDL_SetJoystickVirtualTouchpad'])(a0, a1, a2, a3, a4, a5, a6);
var _sdl3_SDL_SetLogOutputFunction = Module['_sdl3_SDL_SetLogOutputFunction'] = (a0, a1) => (_sdl3_SDL_SetLogOutputFunction = Module['_sdl3_SDL_SetLogOutputFunction'] = wasmExports['sdl3_SDL_SetLogOutputFunction'])(a0, a1);
var _sdl3_SDL_SetLogPriorities = Module['_sdl3_SDL_SetLogPriorities'] = (a0) => (_sdl3_SDL_SetLogPriorities = Module['_sdl3_SDL_SetLogPriorities'] = wasmExports['sdl3_SDL_SetLogPriorities'])(a0);
var _sdl3_SDL_SetLogPriority = Module['_sdl3_SDL_SetLogPriority'] = (a0, a1) => (_sdl3_SDL_SetLogPriority = Module['_sdl3_SDL_SetLogPriority'] = wasmExports['sdl3_SDL_SetLogPriority'])(a0, a1);
var _sdl3_SDL_SetLogPriorityPrefix = Module['_sdl3_SDL_SetLogPriorityPrefix'] = (a0, a1) => (_sdl3_SDL_SetLogPriorityPrefix = Module['_sdl3_SDL_SetLogPriorityPrefix'] = wasmExports['sdl3_SDL_SetLogPriorityPrefix'])(a0, a1);
var _sdl3_SDL_SetMainReady = Module['_sdl3_SDL_SetMainReady'] = () => (_sdl3_SDL_SetMainReady = Module['_sdl3_SDL_SetMainReady'] = wasmExports['sdl3_SDL_SetMainReady'])();
var _sdl3_SDL_SetModState = Module['_sdl3_SDL_SetModState'] = (a0) => (_sdl3_SDL_SetModState = Module['_sdl3_SDL_SetModState'] = wasmExports['sdl3_SDL_SetModState'])(a0);
var _sdl3_SDL_SetNumberProperty = Module['_sdl3_SDL_SetNumberProperty'] = (a0, a1, a2) => (_sdl3_SDL_SetNumberProperty = Module['_sdl3_SDL_SetNumberProperty'] = wasmExports['sdl3_SDL_SetNumberProperty'])(a0, a1, a2);
var _sdl3_SDL_SetPaletteColors = Module['_sdl3_SDL_SetPaletteColors'] = (a0, a1, a2, a3) => (_sdl3_SDL_SetPaletteColors = Module['_sdl3_SDL_SetPaletteColors'] = wasmExports['sdl3_SDL_SetPaletteColors'])(a0, a1, a2, a3);
var _sdl3_SDL_SetPointerProperty = Module['_sdl3_SDL_SetPointerProperty'] = (a0, a1, a2) => (_sdl3_SDL_SetPointerProperty = Module['_sdl3_SDL_SetPointerProperty'] = wasmExports['sdl3_SDL_SetPointerProperty'])(a0, a1, a2);
var _sdl3_SDL_SetPointerPropertyWithCleanup = Module['_sdl3_SDL_SetPointerPropertyWithCleanup'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_SetPointerPropertyWithCleanup = Module['_sdl3_SDL_SetPointerPropertyWithCleanup'] = wasmExports['sdl3_SDL_SetPointerPropertyWithCleanup'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_SetPrimarySelectionText = Module['_sdl3_SDL_SetPrimarySelectionText'] = (a0) => (_sdl3_SDL_SetPrimarySelectionText = Module['_sdl3_SDL_SetPrimarySelectionText'] = wasmExports['sdl3_SDL_SetPrimarySelectionText'])(a0);
var _sdl3_SDL_SetRenderClipRect = Module['_sdl3_SDL_SetRenderClipRect'] = (a0, a1) => (_sdl3_SDL_SetRenderClipRect = Module['_sdl3_SDL_SetRenderClipRect'] = wasmExports['sdl3_SDL_SetRenderClipRect'])(a0, a1);
var _sdl3_SDL_SetRenderColorScale = Module['_sdl3_SDL_SetRenderColorScale'] = (a0, a1) => (_sdl3_SDL_SetRenderColorScale = Module['_sdl3_SDL_SetRenderColorScale'] = wasmExports['sdl3_SDL_SetRenderColorScale'])(a0, a1);
var _sdl3_SDL_SetRenderDrawBlendMode = Module['_sdl3_SDL_SetRenderDrawBlendMode'] = (a0, a1) => (_sdl3_SDL_SetRenderDrawBlendMode = Module['_sdl3_SDL_SetRenderDrawBlendMode'] = wasmExports['sdl3_SDL_SetRenderDrawBlendMode'])(a0, a1);
var _sdl3_SDL_SetRenderDrawColor = Module['_sdl3_SDL_SetRenderDrawColor'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_SetRenderDrawColor = Module['_sdl3_SDL_SetRenderDrawColor'] = wasmExports['sdl3_SDL_SetRenderDrawColor'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_SetRenderDrawColorFloat = Module['_sdl3_SDL_SetRenderDrawColorFloat'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_SetRenderDrawColorFloat = Module['_sdl3_SDL_SetRenderDrawColorFloat'] = wasmExports['sdl3_SDL_SetRenderDrawColorFloat'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_SetRenderLogicalPresentation = Module['_sdl3_SDL_SetRenderLogicalPresentation'] = (a0, a1, a2, a3) => (_sdl3_SDL_SetRenderLogicalPresentation = Module['_sdl3_SDL_SetRenderLogicalPresentation'] = wasmExports['sdl3_SDL_SetRenderLogicalPresentation'])(a0, a1, a2, a3);
var _sdl3_SDL_SetRenderScale = Module['_sdl3_SDL_SetRenderScale'] = (a0, a1, a2) => (_sdl3_SDL_SetRenderScale = Module['_sdl3_SDL_SetRenderScale'] = wasmExports['sdl3_SDL_SetRenderScale'])(a0, a1, a2);
var _sdl3_SDL_SetRenderTarget = Module['_sdl3_SDL_SetRenderTarget'] = (a0, a1) => (_sdl3_SDL_SetRenderTarget = Module['_sdl3_SDL_SetRenderTarget'] = wasmExports['sdl3_SDL_SetRenderTarget'])(a0, a1);
var _sdl3_SDL_SetRenderVSync = Module['_sdl3_SDL_SetRenderVSync'] = (a0, a1) => (_sdl3_SDL_SetRenderVSync = Module['_sdl3_SDL_SetRenderVSync'] = wasmExports['sdl3_SDL_SetRenderVSync'])(a0, a1);
var _sdl3_SDL_SetRenderViewport = Module['_sdl3_SDL_SetRenderViewport'] = (a0, a1) => (_sdl3_SDL_SetRenderViewport = Module['_sdl3_SDL_SetRenderViewport'] = wasmExports['sdl3_SDL_SetRenderViewport'])(a0, a1);
var _sdl3_SDL_SetScancodeName = Module['_sdl3_SDL_SetScancodeName'] = (a0, a1) => (_sdl3_SDL_SetScancodeName = Module['_sdl3_SDL_SetScancodeName'] = wasmExports['sdl3_SDL_SetScancodeName'])(a0, a1);
var _sdl3_SDL_SetStringProperty = Module['_sdl3_SDL_SetStringProperty'] = (a0, a1, a2) => (_sdl3_SDL_SetStringProperty = Module['_sdl3_SDL_SetStringProperty'] = wasmExports['sdl3_SDL_SetStringProperty'])(a0, a1, a2);
var _sdl3_SDL_SetSurfaceAlphaMod = Module['_sdl3_SDL_SetSurfaceAlphaMod'] = (a0, a1) => (_sdl3_SDL_SetSurfaceAlphaMod = Module['_sdl3_SDL_SetSurfaceAlphaMod'] = wasmExports['sdl3_SDL_SetSurfaceAlphaMod'])(a0, a1);
var _sdl3_SDL_SetSurfaceBlendMode = Module['_sdl3_SDL_SetSurfaceBlendMode'] = (a0, a1) => (_sdl3_SDL_SetSurfaceBlendMode = Module['_sdl3_SDL_SetSurfaceBlendMode'] = wasmExports['sdl3_SDL_SetSurfaceBlendMode'])(a0, a1);
var _sdl3_SDL_SetSurfaceClipRect = Module['_sdl3_SDL_SetSurfaceClipRect'] = (a0, a1) => (_sdl3_SDL_SetSurfaceClipRect = Module['_sdl3_SDL_SetSurfaceClipRect'] = wasmExports['sdl3_SDL_SetSurfaceClipRect'])(a0, a1);
var _sdl3_SDL_SetSurfaceColorKey = Module['_sdl3_SDL_SetSurfaceColorKey'] = (a0, a1, a2) => (_sdl3_SDL_SetSurfaceColorKey = Module['_sdl3_SDL_SetSurfaceColorKey'] = wasmExports['sdl3_SDL_SetSurfaceColorKey'])(a0, a1, a2);
var _sdl3_SDL_SetSurfaceColorMod = Module['_sdl3_SDL_SetSurfaceColorMod'] = (a0, a1, a2, a3) => (_sdl3_SDL_SetSurfaceColorMod = Module['_sdl3_SDL_SetSurfaceColorMod'] = wasmExports['sdl3_SDL_SetSurfaceColorMod'])(a0, a1, a2, a3);
var _sdl3_SDL_SetSurfaceColorspace = Module['_sdl3_SDL_SetSurfaceColorspace'] = (a0, a1) => (_sdl3_SDL_SetSurfaceColorspace = Module['_sdl3_SDL_SetSurfaceColorspace'] = wasmExports['sdl3_SDL_SetSurfaceColorspace'])(a0, a1);
var _sdl3_SDL_SetSurfacePalette = Module['_sdl3_SDL_SetSurfacePalette'] = (a0, a1) => (_sdl3_SDL_SetSurfacePalette = Module['_sdl3_SDL_SetSurfacePalette'] = wasmExports['sdl3_SDL_SetSurfacePalette'])(a0, a1);
var _sdl3_SDL_SetSurfaceRLE = Module['_sdl3_SDL_SetSurfaceRLE'] = (a0, a1) => (_sdl3_SDL_SetSurfaceRLE = Module['_sdl3_SDL_SetSurfaceRLE'] = wasmExports['sdl3_SDL_SetSurfaceRLE'])(a0, a1);
var _sdl3_SDL_SetTLS = Module['_sdl3_SDL_SetTLS'] = (a0, a1, a2) => (_sdl3_SDL_SetTLS = Module['_sdl3_SDL_SetTLS'] = wasmExports['sdl3_SDL_SetTLS'])(a0, a1, a2);
var _sdl3_SDL_SetTextInputArea = Module['_sdl3_SDL_SetTextInputArea'] = (a0, a1, a2) => (_sdl3_SDL_SetTextInputArea = Module['_sdl3_SDL_SetTextInputArea'] = wasmExports['sdl3_SDL_SetTextInputArea'])(a0, a1, a2);
var _sdl3_SDL_SetTextureAlphaMod = Module['_sdl3_SDL_SetTextureAlphaMod'] = (a0, a1) => (_sdl3_SDL_SetTextureAlphaMod = Module['_sdl3_SDL_SetTextureAlphaMod'] = wasmExports['sdl3_SDL_SetTextureAlphaMod'])(a0, a1);
var _sdl3_SDL_SetTextureAlphaModFloat = Module['_sdl3_SDL_SetTextureAlphaModFloat'] = (a0, a1) => (_sdl3_SDL_SetTextureAlphaModFloat = Module['_sdl3_SDL_SetTextureAlphaModFloat'] = wasmExports['sdl3_SDL_SetTextureAlphaModFloat'])(a0, a1);
var _sdl3_SDL_SetTextureBlendMode = Module['_sdl3_SDL_SetTextureBlendMode'] = (a0, a1) => (_sdl3_SDL_SetTextureBlendMode = Module['_sdl3_SDL_SetTextureBlendMode'] = wasmExports['sdl3_SDL_SetTextureBlendMode'])(a0, a1);
var _sdl3_SDL_SetTextureColorMod = Module['_sdl3_SDL_SetTextureColorMod'] = (a0, a1, a2, a3) => (_sdl3_SDL_SetTextureColorMod = Module['_sdl3_SDL_SetTextureColorMod'] = wasmExports['sdl3_SDL_SetTextureColorMod'])(a0, a1, a2, a3);
var _sdl3_SDL_SetTextureColorModFloat = Module['_sdl3_SDL_SetTextureColorModFloat'] = (a0, a1, a2, a3) => (_sdl3_SDL_SetTextureColorModFloat = Module['_sdl3_SDL_SetTextureColorModFloat'] = wasmExports['sdl3_SDL_SetTextureColorModFloat'])(a0, a1, a2, a3);
var _sdl3_SDL_SetTextureScaleMode = Module['_sdl3_SDL_SetTextureScaleMode'] = (a0, a1) => (_sdl3_SDL_SetTextureScaleMode = Module['_sdl3_SDL_SetTextureScaleMode'] = wasmExports['sdl3_SDL_SetTextureScaleMode'])(a0, a1);
var _sdl3_SDL_SetTrayEntryCallback = Module['_sdl3_SDL_SetTrayEntryCallback'] = (a0, a1, a2) => (_sdl3_SDL_SetTrayEntryCallback = Module['_sdl3_SDL_SetTrayEntryCallback'] = wasmExports['sdl3_SDL_SetTrayEntryCallback'])(a0, a1, a2);
var _sdl3_SDL_SetTrayEntryChecked = Module['_sdl3_SDL_SetTrayEntryChecked'] = (a0, a1) => (_sdl3_SDL_SetTrayEntryChecked = Module['_sdl3_SDL_SetTrayEntryChecked'] = wasmExports['sdl3_SDL_SetTrayEntryChecked'])(a0, a1);
var _sdl3_SDL_SetTrayEntryEnabled = Module['_sdl3_SDL_SetTrayEntryEnabled'] = (a0, a1) => (_sdl3_SDL_SetTrayEntryEnabled = Module['_sdl3_SDL_SetTrayEntryEnabled'] = wasmExports['sdl3_SDL_SetTrayEntryEnabled'])(a0, a1);
var _sdl3_SDL_SetTrayEntryLabel = Module['_sdl3_SDL_SetTrayEntryLabel'] = (a0, a1) => (_sdl3_SDL_SetTrayEntryLabel = Module['_sdl3_SDL_SetTrayEntryLabel'] = wasmExports['sdl3_SDL_SetTrayEntryLabel'])(a0, a1);
var _sdl3_SDL_SetTrayIcon = Module['_sdl3_SDL_SetTrayIcon'] = (a0, a1) => (_sdl3_SDL_SetTrayIcon = Module['_sdl3_SDL_SetTrayIcon'] = wasmExports['sdl3_SDL_SetTrayIcon'])(a0, a1);
var _sdl3_SDL_SetTrayTooltip = Module['_sdl3_SDL_SetTrayTooltip'] = (a0, a1) => (_sdl3_SDL_SetTrayTooltip = Module['_sdl3_SDL_SetTrayTooltip'] = wasmExports['sdl3_SDL_SetTrayTooltip'])(a0, a1);
var _sdl3_SDL_SetWindowAlwaysOnTop = Module['_sdl3_SDL_SetWindowAlwaysOnTop'] = (a0, a1) => (_sdl3_SDL_SetWindowAlwaysOnTop = Module['_sdl3_SDL_SetWindowAlwaysOnTop'] = wasmExports['sdl3_SDL_SetWindowAlwaysOnTop'])(a0, a1);
var _sdl3_SDL_SetWindowAspectRatio = Module['_sdl3_SDL_SetWindowAspectRatio'] = (a0, a1, a2) => (_sdl3_SDL_SetWindowAspectRatio = Module['_sdl3_SDL_SetWindowAspectRatio'] = wasmExports['sdl3_SDL_SetWindowAspectRatio'])(a0, a1, a2);
var _sdl3_SDL_SetWindowBordered = Module['_sdl3_SDL_SetWindowBordered'] = (a0, a1) => (_sdl3_SDL_SetWindowBordered = Module['_sdl3_SDL_SetWindowBordered'] = wasmExports['sdl3_SDL_SetWindowBordered'])(a0, a1);
var _sdl3_SDL_SetWindowFocusable = Module['_sdl3_SDL_SetWindowFocusable'] = (a0, a1) => (_sdl3_SDL_SetWindowFocusable = Module['_sdl3_SDL_SetWindowFocusable'] = wasmExports['sdl3_SDL_SetWindowFocusable'])(a0, a1);
var _sdl3_SDL_SetWindowFullscreen = Module['_sdl3_SDL_SetWindowFullscreen'] = (a0, a1) => (_sdl3_SDL_SetWindowFullscreen = Module['_sdl3_SDL_SetWindowFullscreen'] = wasmExports['sdl3_SDL_SetWindowFullscreen'])(a0, a1);
var _sdl3_SDL_SetWindowFullscreenMode = Module['_sdl3_SDL_SetWindowFullscreenMode'] = (a0, a1) => (_sdl3_SDL_SetWindowFullscreenMode = Module['_sdl3_SDL_SetWindowFullscreenMode'] = wasmExports['sdl3_SDL_SetWindowFullscreenMode'])(a0, a1);
var _sdl3_SDL_SetWindowHitTest = Module['_sdl3_SDL_SetWindowHitTest'] = (a0, a1, a2) => (_sdl3_SDL_SetWindowHitTest = Module['_sdl3_SDL_SetWindowHitTest'] = wasmExports['sdl3_SDL_SetWindowHitTest'])(a0, a1, a2);
var _sdl3_SDL_SetWindowIcon = Module['_sdl3_SDL_SetWindowIcon'] = (a0, a1) => (_sdl3_SDL_SetWindowIcon = Module['_sdl3_SDL_SetWindowIcon'] = wasmExports['sdl3_SDL_SetWindowIcon'])(a0, a1);
var _sdl3_SDL_SetWindowKeyboardGrab = Module['_sdl3_SDL_SetWindowKeyboardGrab'] = (a0, a1) => (_sdl3_SDL_SetWindowKeyboardGrab = Module['_sdl3_SDL_SetWindowKeyboardGrab'] = wasmExports['sdl3_SDL_SetWindowKeyboardGrab'])(a0, a1);
var _sdl3_SDL_SetWindowMaximumSize = Module['_sdl3_SDL_SetWindowMaximumSize'] = (a0, a1, a2) => (_sdl3_SDL_SetWindowMaximumSize = Module['_sdl3_SDL_SetWindowMaximumSize'] = wasmExports['sdl3_SDL_SetWindowMaximumSize'])(a0, a1, a2);
var _sdl3_SDL_SetWindowMinimumSize = Module['_sdl3_SDL_SetWindowMinimumSize'] = (a0, a1, a2) => (_sdl3_SDL_SetWindowMinimumSize = Module['_sdl3_SDL_SetWindowMinimumSize'] = wasmExports['sdl3_SDL_SetWindowMinimumSize'])(a0, a1, a2);
var _sdl3_SDL_SetWindowModal = Module['_sdl3_SDL_SetWindowModal'] = (a0, a1) => (_sdl3_SDL_SetWindowModal = Module['_sdl3_SDL_SetWindowModal'] = wasmExports['sdl3_SDL_SetWindowModal'])(a0, a1);
var _sdl3_SDL_SetWindowMouseGrab = Module['_sdl3_SDL_SetWindowMouseGrab'] = (a0, a1) => (_sdl3_SDL_SetWindowMouseGrab = Module['_sdl3_SDL_SetWindowMouseGrab'] = wasmExports['sdl3_SDL_SetWindowMouseGrab'])(a0, a1);
var _sdl3_SDL_SetWindowMouseRect = Module['_sdl3_SDL_SetWindowMouseRect'] = (a0, a1) => (_sdl3_SDL_SetWindowMouseRect = Module['_sdl3_SDL_SetWindowMouseRect'] = wasmExports['sdl3_SDL_SetWindowMouseRect'])(a0, a1);
var _sdl3_SDL_SetWindowOpacity = Module['_sdl3_SDL_SetWindowOpacity'] = (a0, a1) => (_sdl3_SDL_SetWindowOpacity = Module['_sdl3_SDL_SetWindowOpacity'] = wasmExports['sdl3_SDL_SetWindowOpacity'])(a0, a1);
var _sdl3_SDL_SetWindowParent = Module['_sdl3_SDL_SetWindowParent'] = (a0, a1) => (_sdl3_SDL_SetWindowParent = Module['_sdl3_SDL_SetWindowParent'] = wasmExports['sdl3_SDL_SetWindowParent'])(a0, a1);
var _sdl3_SDL_SetWindowPosition = Module['_sdl3_SDL_SetWindowPosition'] = (a0, a1, a2) => (_sdl3_SDL_SetWindowPosition = Module['_sdl3_SDL_SetWindowPosition'] = wasmExports['sdl3_SDL_SetWindowPosition'])(a0, a1, a2);
var _sdl3_SDL_SetWindowRelativeMouseMode = Module['_sdl3_SDL_SetWindowRelativeMouseMode'] = (a0, a1) => (_sdl3_SDL_SetWindowRelativeMouseMode = Module['_sdl3_SDL_SetWindowRelativeMouseMode'] = wasmExports['sdl3_SDL_SetWindowRelativeMouseMode'])(a0, a1);
var _sdl3_SDL_SetWindowResizable = Module['_sdl3_SDL_SetWindowResizable'] = (a0, a1) => (_sdl3_SDL_SetWindowResizable = Module['_sdl3_SDL_SetWindowResizable'] = wasmExports['sdl3_SDL_SetWindowResizable'])(a0, a1);
var _sdl3_SDL_SetWindowShape = Module['_sdl3_SDL_SetWindowShape'] = (a0, a1) => (_sdl3_SDL_SetWindowShape = Module['_sdl3_SDL_SetWindowShape'] = wasmExports['sdl3_SDL_SetWindowShape'])(a0, a1);
var _sdl3_SDL_SetWindowSize = Module['_sdl3_SDL_SetWindowSize'] = (a0, a1, a2) => (_sdl3_SDL_SetWindowSize = Module['_sdl3_SDL_SetWindowSize'] = wasmExports['sdl3_SDL_SetWindowSize'])(a0, a1, a2);
var _sdl3_SDL_SetWindowSurfaceVSync = Module['_sdl3_SDL_SetWindowSurfaceVSync'] = (a0, a1) => (_sdl3_SDL_SetWindowSurfaceVSync = Module['_sdl3_SDL_SetWindowSurfaceVSync'] = wasmExports['sdl3_SDL_SetWindowSurfaceVSync'])(a0, a1);
var _sdl3_SDL_SetWindowTitle = Module['_sdl3_SDL_SetWindowTitle'] = (a0, a1) => (_sdl3_SDL_SetWindowTitle = Module['_sdl3_SDL_SetWindowTitle'] = wasmExports['sdl3_SDL_SetWindowTitle'])(a0, a1);
var _sdl3_SDL_ShouldInit = Module['_sdl3_SDL_ShouldInit'] = (a0) => (_sdl3_SDL_ShouldInit = Module['_sdl3_SDL_ShouldInit'] = wasmExports['sdl3_SDL_ShouldInit'])(a0);
var _sdl3_SDL_ShouldQuit = Module['_sdl3_SDL_ShouldQuit'] = (a0) => (_sdl3_SDL_ShouldQuit = Module['_sdl3_SDL_ShouldQuit'] = wasmExports['sdl3_SDL_ShouldQuit'])(a0);
var _sdl3_SDL_ShowCursor = Module['_sdl3_SDL_ShowCursor'] = () => (_sdl3_SDL_ShowCursor = Module['_sdl3_SDL_ShowCursor'] = wasmExports['sdl3_SDL_ShowCursor'])();
var _sdl3_SDL_ShowFileDialogWithProperties = Module['_sdl3_SDL_ShowFileDialogWithProperties'] = (a0, a1, a2, a3) => (_sdl3_SDL_ShowFileDialogWithProperties = Module['_sdl3_SDL_ShowFileDialogWithProperties'] = wasmExports['sdl3_SDL_ShowFileDialogWithProperties'])(a0, a1, a2, a3);
var _sdl3_SDL_ShowMessageBox = Module['_sdl3_SDL_ShowMessageBox'] = (a0, a1) => (_sdl3_SDL_ShowMessageBox = Module['_sdl3_SDL_ShowMessageBox'] = wasmExports['sdl3_SDL_ShowMessageBox'])(a0, a1);
var _sdl3_SDL_ShowOpenFileDialog = Module['_sdl3_SDL_ShowOpenFileDialog'] = (a0, a1, a2, a3, a4, a5, a6) => (_sdl3_SDL_ShowOpenFileDialog = Module['_sdl3_SDL_ShowOpenFileDialog'] = wasmExports['sdl3_SDL_ShowOpenFileDialog'])(a0, a1, a2, a3, a4, a5, a6);
var _sdl3_SDL_ShowOpenFolderDialog = Module['_sdl3_SDL_ShowOpenFolderDialog'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_ShowOpenFolderDialog = Module['_sdl3_SDL_ShowOpenFolderDialog'] = wasmExports['sdl3_SDL_ShowOpenFolderDialog'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_ShowSaveFileDialog = Module['_sdl3_SDL_ShowSaveFileDialog'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_ShowSaveFileDialog = Module['_sdl3_SDL_ShowSaveFileDialog'] = wasmExports['sdl3_SDL_ShowSaveFileDialog'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_ShowSimpleMessageBox = Module['_sdl3_SDL_ShowSimpleMessageBox'] = (a0, a1, a2, a3) => (_sdl3_SDL_ShowSimpleMessageBox = Module['_sdl3_SDL_ShowSimpleMessageBox'] = wasmExports['sdl3_SDL_ShowSimpleMessageBox'])(a0, a1, a2, a3);
var _sdl3_SDL_ShowWindow = Module['_sdl3_SDL_ShowWindow'] = (a0) => (_sdl3_SDL_ShowWindow = Module['_sdl3_SDL_ShowWindow'] = wasmExports['sdl3_SDL_ShowWindow'])(a0);
var _sdl3_SDL_ShowWindowSystemMenu = Module['_sdl3_SDL_ShowWindowSystemMenu'] = (a0, a1, a2) => (_sdl3_SDL_ShowWindowSystemMenu = Module['_sdl3_SDL_ShowWindowSystemMenu'] = wasmExports['sdl3_SDL_ShowWindowSystemMenu'])(a0, a1, a2);
var _sdl3_SDL_SignalAsyncIOQueue = Module['_sdl3_SDL_SignalAsyncIOQueue'] = (a0) => (_sdl3_SDL_SignalAsyncIOQueue = Module['_sdl3_SDL_SignalAsyncIOQueue'] = wasmExports['sdl3_SDL_SignalAsyncIOQueue'])(a0);
var _sdl3_SDL_SignalCondition = Module['_sdl3_SDL_SignalCondition'] = (a0) => (_sdl3_SDL_SignalCondition = Module['_sdl3_SDL_SignalCondition'] = wasmExports['sdl3_SDL_SignalCondition'])(a0);
var _sdl3_SDL_SignalSemaphore = Module['_sdl3_SDL_SignalSemaphore'] = (a0) => (_sdl3_SDL_SignalSemaphore = Module['_sdl3_SDL_SignalSemaphore'] = wasmExports['sdl3_SDL_SignalSemaphore'])(a0);
var _sdl3_SDL_StartTextInput = Module['_sdl3_SDL_StartTextInput'] = (a0) => (_sdl3_SDL_StartTextInput = Module['_sdl3_SDL_StartTextInput'] = wasmExports['sdl3_SDL_StartTextInput'])(a0);
var _sdl3_SDL_StartTextInputWithProperties = Module['_sdl3_SDL_StartTextInputWithProperties'] = (a0, a1) => (_sdl3_SDL_StartTextInputWithProperties = Module['_sdl3_SDL_StartTextInputWithProperties'] = wasmExports['sdl3_SDL_StartTextInputWithProperties'])(a0, a1);
var _sdl3_SDL_StopHapticEffect = Module['_sdl3_SDL_StopHapticEffect'] = (a0, a1) => (_sdl3_SDL_StopHapticEffect = Module['_sdl3_SDL_StopHapticEffect'] = wasmExports['sdl3_SDL_StopHapticEffect'])(a0, a1);
var _sdl3_SDL_StopHapticEffects = Module['_sdl3_SDL_StopHapticEffects'] = (a0) => (_sdl3_SDL_StopHapticEffects = Module['_sdl3_SDL_StopHapticEffects'] = wasmExports['sdl3_SDL_StopHapticEffects'])(a0);
var _sdl3_SDL_StopHapticRumble = Module['_sdl3_SDL_StopHapticRumble'] = (a0) => (_sdl3_SDL_StopHapticRumble = Module['_sdl3_SDL_StopHapticRumble'] = wasmExports['sdl3_SDL_StopHapticRumble'])(a0);
var _sdl3_SDL_StopTextInput = Module['_sdl3_SDL_StopTextInput'] = (a0) => (_sdl3_SDL_StopTextInput = Module['_sdl3_SDL_StopTextInput'] = wasmExports['sdl3_SDL_StopTextInput'])(a0);
var _sdl3_SDL_StorageReady = Module['_sdl3_SDL_StorageReady'] = (a0) => (_sdl3_SDL_StorageReady = Module['_sdl3_SDL_StorageReady'] = wasmExports['sdl3_SDL_StorageReady'])(a0);
var _sdl3_SDL_StringToGUID = Module['_sdl3_SDL_StringToGUID'] = (a0) => (_sdl3_SDL_StringToGUID = Module['_sdl3_SDL_StringToGUID'] = wasmExports['sdl3_SDL_StringToGUID'])(a0);
var _sdl3_SDL_SubmitGPUCommandBuffer = Module['_sdl3_SDL_SubmitGPUCommandBuffer'] = (a0) => (_sdl3_SDL_SubmitGPUCommandBuffer = Module['_sdl3_SDL_SubmitGPUCommandBuffer'] = wasmExports['sdl3_SDL_SubmitGPUCommandBuffer'])(a0);
var _sdl3_SDL_SubmitGPUCommandBufferAndAcquireFence = Module['_sdl3_SDL_SubmitGPUCommandBufferAndAcquireFence'] = (a0) => (_sdl3_SDL_SubmitGPUCommandBufferAndAcquireFence = Module['_sdl3_SDL_SubmitGPUCommandBufferAndAcquireFence'] = wasmExports['sdl3_SDL_SubmitGPUCommandBufferAndAcquireFence'])(a0);
var _sdl3_SDL_SurfaceHasAlternateImages = Module['_sdl3_SDL_SurfaceHasAlternateImages'] = (a0) => (_sdl3_SDL_SurfaceHasAlternateImages = Module['_sdl3_SDL_SurfaceHasAlternateImages'] = wasmExports['sdl3_SDL_SurfaceHasAlternateImages'])(a0);
var _sdl3_SDL_SurfaceHasColorKey = Module['_sdl3_SDL_SurfaceHasColorKey'] = (a0) => (_sdl3_SDL_SurfaceHasColorKey = Module['_sdl3_SDL_SurfaceHasColorKey'] = wasmExports['sdl3_SDL_SurfaceHasColorKey'])(a0);
var _sdl3_SDL_SurfaceHasRLE = Module['_sdl3_SDL_SurfaceHasRLE'] = (a0) => (_sdl3_SDL_SurfaceHasRLE = Module['_sdl3_SDL_SurfaceHasRLE'] = wasmExports['sdl3_SDL_SurfaceHasRLE'])(a0);
var _sdl3_SDL_SyncWindow = Module['_sdl3_SDL_SyncWindow'] = (a0) => (_sdl3_SDL_SyncWindow = Module['_sdl3_SDL_SyncWindow'] = wasmExports['sdl3_SDL_SyncWindow'])(a0);
var _sdl3_SDL_TellIO = Module['_sdl3_SDL_TellIO'] = (a0) => (_sdl3_SDL_TellIO = Module['_sdl3_SDL_TellIO'] = wasmExports['sdl3_SDL_TellIO'])(a0);
var _sdl3_SDL_TextInputActive = Module['_sdl3_SDL_TextInputActive'] = (a0) => (_sdl3_SDL_TextInputActive = Module['_sdl3_SDL_TextInputActive'] = wasmExports['sdl3_SDL_TextInputActive'])(a0);
var _sdl3_SDL_TimeFromWindows = Module['_sdl3_SDL_TimeFromWindows'] = (a0, a1) => (_sdl3_SDL_TimeFromWindows = Module['_sdl3_SDL_TimeFromWindows'] = wasmExports['sdl3_SDL_TimeFromWindows'])(a0, a1);
var _sdl3_SDL_TimeToDateTime = Module['_sdl3_SDL_TimeToDateTime'] = (a0, a1, a2) => (_sdl3_SDL_TimeToDateTime = Module['_sdl3_SDL_TimeToDateTime'] = wasmExports['sdl3_SDL_TimeToDateTime'])(a0, a1, a2);
var _sdl3_SDL_TimeToWindows = Module['_sdl3_SDL_TimeToWindows'] = (a0, a1, a2) => (_sdl3_SDL_TimeToWindows = Module['_sdl3_SDL_TimeToWindows'] = wasmExports['sdl3_SDL_TimeToWindows'])(a0, a1, a2);
var _sdl3_SDL_TryLockMutex = Module['_sdl3_SDL_TryLockMutex'] = (a0) => (_sdl3_SDL_TryLockMutex = Module['_sdl3_SDL_TryLockMutex'] = wasmExports['sdl3_SDL_TryLockMutex'])(a0);
var _sdl3_SDL_TryLockRWLockForReading = Module['_sdl3_SDL_TryLockRWLockForReading'] = (a0) => (_sdl3_SDL_TryLockRWLockForReading = Module['_sdl3_SDL_TryLockRWLockForReading'] = wasmExports['sdl3_SDL_TryLockRWLockForReading'])(a0);
var _sdl3_SDL_TryLockRWLockForWriting = Module['_sdl3_SDL_TryLockRWLockForWriting'] = (a0) => (_sdl3_SDL_TryLockRWLockForWriting = Module['_sdl3_SDL_TryLockRWLockForWriting'] = wasmExports['sdl3_SDL_TryLockRWLockForWriting'])(a0);
var _sdl3_SDL_TryLockSpinlock = Module['_sdl3_SDL_TryLockSpinlock'] = (a0) => (_sdl3_SDL_TryLockSpinlock = Module['_sdl3_SDL_TryLockSpinlock'] = wasmExports['sdl3_SDL_TryLockSpinlock'])(a0);
var _sdl3_SDL_TryWaitSemaphore = Module['_sdl3_SDL_TryWaitSemaphore'] = (a0) => (_sdl3_SDL_TryWaitSemaphore = Module['_sdl3_SDL_TryWaitSemaphore'] = wasmExports['sdl3_SDL_TryWaitSemaphore'])(a0);
var _sdl3_SDL_UnbindAudioStream = Module['_sdl3_SDL_UnbindAudioStream'] = (a0) => (_sdl3_SDL_UnbindAudioStream = Module['_sdl3_SDL_UnbindAudioStream'] = wasmExports['sdl3_SDL_UnbindAudioStream'])(a0);
var _sdl3_SDL_UnbindAudioStreams = Module['_sdl3_SDL_UnbindAudioStreams'] = (a0, a1) => (_sdl3_SDL_UnbindAudioStreams = Module['_sdl3_SDL_UnbindAudioStreams'] = wasmExports['sdl3_SDL_UnbindAudioStreams'])(a0, a1);
var _sdl3_SDL_UnloadObject = Module['_sdl3_SDL_UnloadObject'] = (a0) => (_sdl3_SDL_UnloadObject = Module['_sdl3_SDL_UnloadObject'] = wasmExports['sdl3_SDL_UnloadObject'])(a0);
var _sdl3_SDL_UnlockAudioStream = Module['_sdl3_SDL_UnlockAudioStream'] = (a0) => (_sdl3_SDL_UnlockAudioStream = Module['_sdl3_SDL_UnlockAudioStream'] = wasmExports['sdl3_SDL_UnlockAudioStream'])(a0);
var _sdl3_SDL_UnlockJoysticks = Module['_sdl3_SDL_UnlockJoysticks'] = () => (_sdl3_SDL_UnlockJoysticks = Module['_sdl3_SDL_UnlockJoysticks'] = wasmExports['sdl3_SDL_UnlockJoysticks'])();
var _sdl3_SDL_UnlockMutex = Module['_sdl3_SDL_UnlockMutex'] = (a0) => (_sdl3_SDL_UnlockMutex = Module['_sdl3_SDL_UnlockMutex'] = wasmExports['sdl3_SDL_UnlockMutex'])(a0);
var _sdl3_SDL_UnlockProperties = Module['_sdl3_SDL_UnlockProperties'] = (a0) => (_sdl3_SDL_UnlockProperties = Module['_sdl3_SDL_UnlockProperties'] = wasmExports['sdl3_SDL_UnlockProperties'])(a0);
var _sdl3_SDL_UnlockRWLock = Module['_sdl3_SDL_UnlockRWLock'] = (a0) => (_sdl3_SDL_UnlockRWLock = Module['_sdl3_SDL_UnlockRWLock'] = wasmExports['sdl3_SDL_UnlockRWLock'])(a0);
var _sdl3_SDL_UnlockSpinlock = Module['_sdl3_SDL_UnlockSpinlock'] = (a0) => (_sdl3_SDL_UnlockSpinlock = Module['_sdl3_SDL_UnlockSpinlock'] = wasmExports['sdl3_SDL_UnlockSpinlock'])(a0);
var _sdl3_SDL_UnlockSurface = Module['_sdl3_SDL_UnlockSurface'] = (a0) => (_sdl3_SDL_UnlockSurface = Module['_sdl3_SDL_UnlockSurface'] = wasmExports['sdl3_SDL_UnlockSurface'])(a0);
var _sdl3_SDL_UnlockTexture = Module['_sdl3_SDL_UnlockTexture'] = (a0) => (_sdl3_SDL_UnlockTexture = Module['_sdl3_SDL_UnlockTexture'] = wasmExports['sdl3_SDL_UnlockTexture'])(a0);
var _sdl3_SDL_UnmapGPUTransferBuffer = Module['_sdl3_SDL_UnmapGPUTransferBuffer'] = (a0, a1) => (_sdl3_SDL_UnmapGPUTransferBuffer = Module['_sdl3_SDL_UnmapGPUTransferBuffer'] = wasmExports['sdl3_SDL_UnmapGPUTransferBuffer'])(a0, a1);
var _sdl3_SDL_UpdateGamepads = Module['_sdl3_SDL_UpdateGamepads'] = () => (_sdl3_SDL_UpdateGamepads = Module['_sdl3_SDL_UpdateGamepads'] = wasmExports['sdl3_SDL_UpdateGamepads'])();
var _sdl3_SDL_UpdateHapticEffect = Module['_sdl3_SDL_UpdateHapticEffect'] = (a0, a1, a2) => (_sdl3_SDL_UpdateHapticEffect = Module['_sdl3_SDL_UpdateHapticEffect'] = wasmExports['sdl3_SDL_UpdateHapticEffect'])(a0, a1, a2);
var _sdl3_SDL_UpdateJoysticks = Module['_sdl3_SDL_UpdateJoysticks'] = () => (_sdl3_SDL_UpdateJoysticks = Module['_sdl3_SDL_UpdateJoysticks'] = wasmExports['sdl3_SDL_UpdateJoysticks'])();
var _sdl3_SDL_UpdateNVTexture = Module['_sdl3_SDL_UpdateNVTexture'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_UpdateNVTexture = Module['_sdl3_SDL_UpdateNVTexture'] = wasmExports['sdl3_SDL_UpdateNVTexture'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_UpdateSensors = Module['_sdl3_SDL_UpdateSensors'] = () => (_sdl3_SDL_UpdateSensors = Module['_sdl3_SDL_UpdateSensors'] = wasmExports['sdl3_SDL_UpdateSensors'])();
var _sdl3_SDL_UpdateTexture = Module['_sdl3_SDL_UpdateTexture'] = (a0, a1, a2, a3) => (_sdl3_SDL_UpdateTexture = Module['_sdl3_SDL_UpdateTexture'] = wasmExports['sdl3_SDL_UpdateTexture'])(a0, a1, a2, a3);
var _sdl3_SDL_UpdateWindowSurface = Module['_sdl3_SDL_UpdateWindowSurface'] = (a0) => (_sdl3_SDL_UpdateWindowSurface = Module['_sdl3_SDL_UpdateWindowSurface'] = wasmExports['sdl3_SDL_UpdateWindowSurface'])(a0);
var _sdl3_SDL_UpdateWindowSurfaceRects = Module['_sdl3_SDL_UpdateWindowSurfaceRects'] = (a0, a1, a2) => (_sdl3_SDL_UpdateWindowSurfaceRects = Module['_sdl3_SDL_UpdateWindowSurfaceRects'] = wasmExports['sdl3_SDL_UpdateWindowSurfaceRects'])(a0, a1, a2);
var _sdl3_SDL_UpdateYUVTexture = Module['_sdl3_SDL_UpdateYUVTexture'] = (a0, a1, a2, a3, a4, a5, a6, a7) => (_sdl3_SDL_UpdateYUVTexture = Module['_sdl3_SDL_UpdateYUVTexture'] = wasmExports['sdl3_SDL_UpdateYUVTexture'])(a0, a1, a2, a3, a4, a5, a6, a7);
var _sdl3_SDL_UploadToGPUBuffer = Module['_sdl3_SDL_UploadToGPUBuffer'] = (a0, a1, a2, a3) => (_sdl3_SDL_UploadToGPUBuffer = Module['_sdl3_SDL_UploadToGPUBuffer'] = wasmExports['sdl3_SDL_UploadToGPUBuffer'])(a0, a1, a2, a3);
var _sdl3_SDL_UploadToGPUTexture = Module['_sdl3_SDL_UploadToGPUTexture'] = (a0, a1, a2, a3) => (_sdl3_SDL_UploadToGPUTexture = Module['_sdl3_SDL_UploadToGPUTexture'] = wasmExports['sdl3_SDL_UploadToGPUTexture'])(a0, a1, a2, a3);
var _sdl3_SDL_WaitAndAcquireGPUSwapchainTexture = Module['_sdl3_SDL_WaitAndAcquireGPUSwapchainTexture'] = (a0, a1, a2, a3, a4) => (_sdl3_SDL_WaitAndAcquireGPUSwapchainTexture = Module['_sdl3_SDL_WaitAndAcquireGPUSwapchainTexture'] = wasmExports['sdl3_SDL_WaitAndAcquireGPUSwapchainTexture'])(a0, a1, a2, a3, a4);
var _sdl3_SDL_WaitAsyncIOResult = Module['_sdl3_SDL_WaitAsyncIOResult'] = (a0, a1, a2) => (_sdl3_SDL_WaitAsyncIOResult = Module['_sdl3_SDL_WaitAsyncIOResult'] = wasmExports['sdl3_SDL_WaitAsyncIOResult'])(a0, a1, a2);
var _sdl3_SDL_WaitCondition = Module['_sdl3_SDL_WaitCondition'] = (a0, a1) => (_sdl3_SDL_WaitCondition = Module['_sdl3_SDL_WaitCondition'] = wasmExports['sdl3_SDL_WaitCondition'])(a0, a1);
var _sdl3_SDL_WaitConditionTimeout = Module['_sdl3_SDL_WaitConditionTimeout'] = (a0, a1, a2) => (_sdl3_SDL_WaitConditionTimeout = Module['_sdl3_SDL_WaitConditionTimeout'] = wasmExports['sdl3_SDL_WaitConditionTimeout'])(a0, a1, a2);
var _sdl3_SDL_WaitEvent = Module['_sdl3_SDL_WaitEvent'] = (a0) => (_sdl3_SDL_WaitEvent = Module['_sdl3_SDL_WaitEvent'] = wasmExports['sdl3_SDL_WaitEvent'])(a0);
var _sdl3_SDL_WaitEventTimeout = Module['_sdl3_SDL_WaitEventTimeout'] = (a0, a1) => (_sdl3_SDL_WaitEventTimeout = Module['_sdl3_SDL_WaitEventTimeout'] = wasmExports['sdl3_SDL_WaitEventTimeout'])(a0, a1);
var _sdl3_SDL_WaitForGPUFences = Module['_sdl3_SDL_WaitForGPUFences'] = (a0, a1, a2, a3) => (_sdl3_SDL_WaitForGPUFences = Module['_sdl3_SDL_WaitForGPUFences'] = wasmExports['sdl3_SDL_WaitForGPUFences'])(a0, a1, a2, a3);
var _sdl3_SDL_WaitForGPUIdle = Module['_sdl3_SDL_WaitForGPUIdle'] = (a0) => (_sdl3_SDL_WaitForGPUIdle = Module['_sdl3_SDL_WaitForGPUIdle'] = wasmExports['sdl3_SDL_WaitForGPUIdle'])(a0);
var _sdl3_SDL_WaitForGPUSwapchain = Module['_sdl3_SDL_WaitForGPUSwapchain'] = (a0, a1) => (_sdl3_SDL_WaitForGPUSwapchain = Module['_sdl3_SDL_WaitForGPUSwapchain'] = wasmExports['sdl3_SDL_WaitForGPUSwapchain'])(a0, a1);
var _sdl3_SDL_WaitProcess = Module['_sdl3_SDL_WaitProcess'] = (a0, a1, a2) => (_sdl3_SDL_WaitProcess = Module['_sdl3_SDL_WaitProcess'] = wasmExports['sdl3_SDL_WaitProcess'])(a0, a1, a2);
var _sdl3_SDL_WaitSemaphore = Module['_sdl3_SDL_WaitSemaphore'] = (a0) => (_sdl3_SDL_WaitSemaphore = Module['_sdl3_SDL_WaitSemaphore'] = wasmExports['sdl3_SDL_WaitSemaphore'])(a0);
var _sdl3_SDL_WaitSemaphoreTimeout = Module['_sdl3_SDL_WaitSemaphoreTimeout'] = (a0, a1) => (_sdl3_SDL_WaitSemaphoreTimeout = Module['_sdl3_SDL_WaitSemaphoreTimeout'] = wasmExports['sdl3_SDL_WaitSemaphoreTimeout'])(a0, a1);
var _sdl3_SDL_WaitThread = Module['_sdl3_SDL_WaitThread'] = (a0, a1) => (_sdl3_SDL_WaitThread = Module['_sdl3_SDL_WaitThread'] = wasmExports['sdl3_SDL_WaitThread'])(a0, a1);
var _sdl3_SDL_WarpMouseGlobal = Module['_sdl3_SDL_WarpMouseGlobal'] = (a0, a1) => (_sdl3_SDL_WarpMouseGlobal = Module['_sdl3_SDL_WarpMouseGlobal'] = wasmExports['sdl3_SDL_WarpMouseGlobal'])(a0, a1);
var _sdl3_SDL_WarpMouseInWindow = Module['_sdl3_SDL_WarpMouseInWindow'] = (a0, a1, a2) => (_sdl3_SDL_WarpMouseInWindow = Module['_sdl3_SDL_WarpMouseInWindow'] = wasmExports['sdl3_SDL_WarpMouseInWindow'])(a0, a1, a2);
var _sdl3_SDL_WasInit = Module['_sdl3_SDL_WasInit'] = (a0) => (_sdl3_SDL_WasInit = Module['_sdl3_SDL_WasInit'] = wasmExports['sdl3_SDL_WasInit'])(a0);
var _sdl3_SDL_WindowHasSurface = Module['_sdl3_SDL_WindowHasSurface'] = (a0) => (_sdl3_SDL_WindowHasSurface = Module['_sdl3_SDL_WindowHasSurface'] = wasmExports['sdl3_SDL_WindowHasSurface'])(a0);
var _sdl3_SDL_WindowSupportsGPUPresentMode = Module['_sdl3_SDL_WindowSupportsGPUPresentMode'] = (a0, a1, a2) => (_sdl3_SDL_WindowSupportsGPUPresentMode = Module['_sdl3_SDL_WindowSupportsGPUPresentMode'] = wasmExports['sdl3_SDL_WindowSupportsGPUPresentMode'])(a0, a1, a2);
var _sdl3_SDL_WindowSupportsGPUSwapchainComposition = Module['_sdl3_SDL_WindowSupportsGPUSwapchainComposition'] = (a0, a1, a2) => (_sdl3_SDL_WindowSupportsGPUSwapchainComposition = Module['_sdl3_SDL_WindowSupportsGPUSwapchainComposition'] = wasmExports['sdl3_SDL_WindowSupportsGPUSwapchainComposition'])(a0, a1, a2);
var _sdl3_SDL_WriteAsyncIO = Module['_sdl3_SDL_WriteAsyncIO'] = (a0, a1, a2, a3, a4, a5) => (_sdl3_SDL_WriteAsyncIO = Module['_sdl3_SDL_WriteAsyncIO'] = wasmExports['sdl3_SDL_WriteAsyncIO'])(a0, a1, a2, a3, a4, a5);
var _sdl3_SDL_WriteIO = Module['_sdl3_SDL_WriteIO'] = (a0, a1, a2) => (_sdl3_SDL_WriteIO = Module['_sdl3_SDL_WriteIO'] = wasmExports['sdl3_SDL_WriteIO'])(a0, a1, a2);
var _sdl3_SDL_WriteS16BE = Module['_sdl3_SDL_WriteS16BE'] = (a0, a1) => (_sdl3_SDL_WriteS16BE = Module['_sdl3_SDL_WriteS16BE'] = wasmExports['sdl3_SDL_WriteS16BE'])(a0, a1);
var _sdl3_SDL_WriteS16LE = Module['_sdl3_SDL_WriteS16LE'] = (a0, a1) => (_sdl3_SDL_WriteS16LE = Module['_sdl3_SDL_WriteS16LE'] = wasmExports['sdl3_SDL_WriteS16LE'])(a0, a1);
var _sdl3_SDL_WriteS32BE = Module['_sdl3_SDL_WriteS32BE'] = (a0, a1) => (_sdl3_SDL_WriteS32BE = Module['_sdl3_SDL_WriteS32BE'] = wasmExports['sdl3_SDL_WriteS32BE'])(a0, a1);
var _sdl3_SDL_WriteS32LE = Module['_sdl3_SDL_WriteS32LE'] = (a0, a1) => (_sdl3_SDL_WriteS32LE = Module['_sdl3_SDL_WriteS32LE'] = wasmExports['sdl3_SDL_WriteS32LE'])(a0, a1);
var _sdl3_SDL_WriteS64BE = Module['_sdl3_SDL_WriteS64BE'] = (a0, a1) => (_sdl3_SDL_WriteS64BE = Module['_sdl3_SDL_WriteS64BE'] = wasmExports['sdl3_SDL_WriteS64BE'])(a0, a1);
var _sdl3_SDL_WriteS64LE = Module['_sdl3_SDL_WriteS64LE'] = (a0, a1) => (_sdl3_SDL_WriteS64LE = Module['_sdl3_SDL_WriteS64LE'] = wasmExports['sdl3_SDL_WriteS64LE'])(a0, a1);
var _sdl3_SDL_WriteS8 = Module['_sdl3_SDL_WriteS8'] = (a0, a1) => (_sdl3_SDL_WriteS8 = Module['_sdl3_SDL_WriteS8'] = wasmExports['sdl3_SDL_WriteS8'])(a0, a1);
var _sdl3_SDL_WriteStorageFile = Module['_sdl3_SDL_WriteStorageFile'] = (a0, a1, a2, a3) => (_sdl3_SDL_WriteStorageFile = Module['_sdl3_SDL_WriteStorageFile'] = wasmExports['sdl3_SDL_WriteStorageFile'])(a0, a1, a2, a3);
var _sdl3_SDL_WriteSurfacePixel = Module['_sdl3_SDL_WriteSurfacePixel'] = (a0, a1, a2, a3, a4, a5, a6) => (_sdl3_SDL_WriteSurfacePixel = Module['_sdl3_SDL_WriteSurfacePixel'] = wasmExports['sdl3_SDL_WriteSurfacePixel'])(a0, a1, a2, a3, a4, a5, a6);
var _sdl3_SDL_WriteSurfacePixelFloat = Module['_sdl3_SDL_WriteSurfacePixelFloat'] = (a0, a1, a2, a3, a4, a5, a6) => (_sdl3_SDL_WriteSurfacePixelFloat = Module['_sdl3_SDL_WriteSurfacePixelFloat'] = wasmExports['sdl3_SDL_WriteSurfacePixelFloat'])(a0, a1, a2, a3, a4, a5, a6);
var _sdl3_SDL_WriteU16BE = Module['_sdl3_SDL_WriteU16BE'] = (a0, a1) => (_sdl3_SDL_WriteU16BE = Module['_sdl3_SDL_WriteU16BE'] = wasmExports['sdl3_SDL_WriteU16BE'])(a0, a1);
var _sdl3_SDL_WriteU16LE = Module['_sdl3_SDL_WriteU16LE'] = (a0, a1) => (_sdl3_SDL_WriteU16LE = Module['_sdl3_SDL_WriteU16LE'] = wasmExports['sdl3_SDL_WriteU16LE'])(a0, a1);
var _sdl3_SDL_WriteU32BE = Module['_sdl3_SDL_WriteU32BE'] = (a0, a1) => (_sdl3_SDL_WriteU32BE = Module['_sdl3_SDL_WriteU32BE'] = wasmExports['sdl3_SDL_WriteU32BE'])(a0, a1);
var _sdl3_SDL_WriteU32LE = Module['_sdl3_SDL_WriteU32LE'] = (a0, a1) => (_sdl3_SDL_WriteU32LE = Module['_sdl3_SDL_WriteU32LE'] = wasmExports['sdl3_SDL_WriteU32LE'])(a0, a1);
var _sdl3_SDL_WriteU64BE = Module['_sdl3_SDL_WriteU64BE'] = (a0, a1) => (_sdl3_SDL_WriteU64BE = Module['_sdl3_SDL_WriteU64BE'] = wasmExports['sdl3_SDL_WriteU64BE'])(a0, a1);
var _sdl3_SDL_WriteU64LE = Module['_sdl3_SDL_WriteU64LE'] = (a0, a1) => (_sdl3_SDL_WriteU64LE = Module['_sdl3_SDL_WriteU64LE'] = wasmExports['sdl3_SDL_WriteU64LE'])(a0, a1);
var _sdl3_SDL_WriteU8 = Module['_sdl3_SDL_WriteU8'] = (a0, a1) => (_sdl3_SDL_WriteU8 = Module['_sdl3_SDL_WriteU8'] = wasmExports['sdl3_SDL_WriteU8'])(a0, a1);
var _sdl3_SDL_free = Module['_sdl3_SDL_free'] = (a0) => (_sdl3_SDL_free = Module['_sdl3_SDL_free'] = wasmExports['sdl3_SDL_free'])(a0);
var _sdl3_SDL_hid_ble_scan = Module['_sdl3_SDL_hid_ble_scan'] = (a0) => (_sdl3_SDL_hid_ble_scan = Module['_sdl3_SDL_hid_ble_scan'] = wasmExports['sdl3_SDL_hid_ble_scan'])(a0);
var _sdl3_SDL_hid_close = Module['_sdl3_SDL_hid_close'] = (a0) => (_sdl3_SDL_hid_close = Module['_sdl3_SDL_hid_close'] = wasmExports['sdl3_SDL_hid_close'])(a0);
var _sdl3_SDL_hid_device_change_count = Module['_sdl3_SDL_hid_device_change_count'] = () => (_sdl3_SDL_hid_device_change_count = Module['_sdl3_SDL_hid_device_change_count'] = wasmExports['sdl3_SDL_hid_device_change_count'])();
var _sdl3_SDL_hid_enumerate = Module['_sdl3_SDL_hid_enumerate'] = (a0, a1) => (_sdl3_SDL_hid_enumerate = Module['_sdl3_SDL_hid_enumerate'] = wasmExports['sdl3_SDL_hid_enumerate'])(a0, a1);
var _sdl3_SDL_hid_exit = Module['_sdl3_SDL_hid_exit'] = () => (_sdl3_SDL_hid_exit = Module['_sdl3_SDL_hid_exit'] = wasmExports['sdl3_SDL_hid_exit'])();
var _sdl3_SDL_hid_free_enumeration = Module['_sdl3_SDL_hid_free_enumeration'] = (a0) => (_sdl3_SDL_hid_free_enumeration = Module['_sdl3_SDL_hid_free_enumeration'] = wasmExports['sdl3_SDL_hid_free_enumeration'])(a0);
var _sdl3_SDL_hid_get_device_info = Module['_sdl3_SDL_hid_get_device_info'] = (a0) => (_sdl3_SDL_hid_get_device_info = Module['_sdl3_SDL_hid_get_device_info'] = wasmExports['sdl3_SDL_hid_get_device_info'])(a0);
var _sdl3_SDL_hid_get_feature_report = Module['_sdl3_SDL_hid_get_feature_report'] = (a0, a1, a2) => (_sdl3_SDL_hid_get_feature_report = Module['_sdl3_SDL_hid_get_feature_report'] = wasmExports['sdl3_SDL_hid_get_feature_report'])(a0, a1, a2);
var _sdl3_SDL_hid_get_indexed_string = Module['_sdl3_SDL_hid_get_indexed_string'] = (a0, a1, a2, a3) => (_sdl3_SDL_hid_get_indexed_string = Module['_sdl3_SDL_hid_get_indexed_string'] = wasmExports['sdl3_SDL_hid_get_indexed_string'])(a0, a1, a2, a3);
var _sdl3_SDL_hid_get_input_report = Module['_sdl3_SDL_hid_get_input_report'] = (a0, a1, a2) => (_sdl3_SDL_hid_get_input_report = Module['_sdl3_SDL_hid_get_input_report'] = wasmExports['sdl3_SDL_hid_get_input_report'])(a0, a1, a2);
var _sdl3_SDL_hid_get_manufacturer_string = Module['_sdl3_SDL_hid_get_manufacturer_string'] = (a0, a1, a2) => (_sdl3_SDL_hid_get_manufacturer_string = Module['_sdl3_SDL_hid_get_manufacturer_string'] = wasmExports['sdl3_SDL_hid_get_manufacturer_string'])(a0, a1, a2);
var _sdl3_SDL_hid_get_product_string = Module['_sdl3_SDL_hid_get_product_string'] = (a0, a1, a2) => (_sdl3_SDL_hid_get_product_string = Module['_sdl3_SDL_hid_get_product_string'] = wasmExports['sdl3_SDL_hid_get_product_string'])(a0, a1, a2);
var _sdl3_SDL_hid_get_report_descriptor = Module['_sdl3_SDL_hid_get_report_descriptor'] = (a0, a1, a2) => (_sdl3_SDL_hid_get_report_descriptor = Module['_sdl3_SDL_hid_get_report_descriptor'] = wasmExports['sdl3_SDL_hid_get_report_descriptor'])(a0, a1, a2);
var _sdl3_SDL_hid_get_serial_number_string = Module['_sdl3_SDL_hid_get_serial_number_string'] = (a0, a1, a2) => (_sdl3_SDL_hid_get_serial_number_string = Module['_sdl3_SDL_hid_get_serial_number_string'] = wasmExports['sdl3_SDL_hid_get_serial_number_string'])(a0, a1, a2);
var _sdl3_SDL_hid_init = Module['_sdl3_SDL_hid_init'] = () => (_sdl3_SDL_hid_init = Module['_sdl3_SDL_hid_init'] = wasmExports['sdl3_SDL_hid_init'])();
var _sdl3_SDL_hid_open = Module['_sdl3_SDL_hid_open'] = (a0, a1, a2) => (_sdl3_SDL_hid_open = Module['_sdl3_SDL_hid_open'] = wasmExports['sdl3_SDL_hid_open'])(a0, a1, a2);
var _sdl3_SDL_hid_open_path = Module['_sdl3_SDL_hid_open_path'] = (a0) => (_sdl3_SDL_hid_open_path = Module['_sdl3_SDL_hid_open_path'] = wasmExports['sdl3_SDL_hid_open_path'])(a0);
var _sdl3_SDL_hid_read = Module['_sdl3_SDL_hid_read'] = (a0, a1, a2) => (_sdl3_SDL_hid_read = Module['_sdl3_SDL_hid_read'] = wasmExports['sdl3_SDL_hid_read'])(a0, a1, a2);
var _sdl3_SDL_hid_read_timeout = Module['_sdl3_SDL_hid_read_timeout'] = (a0, a1, a2, a3) => (_sdl3_SDL_hid_read_timeout = Module['_sdl3_SDL_hid_read_timeout'] = wasmExports['sdl3_SDL_hid_read_timeout'])(a0, a1, a2, a3);
var _sdl3_SDL_hid_send_feature_report = Module['_sdl3_SDL_hid_send_feature_report'] = (a0, a1, a2) => (_sdl3_SDL_hid_send_feature_report = Module['_sdl3_SDL_hid_send_feature_report'] = wasmExports['sdl3_SDL_hid_send_feature_report'])(a0, a1, a2);
var _sdl3_SDL_hid_set_nonblocking = Module['_sdl3_SDL_hid_set_nonblocking'] = (a0, a1) => (_sdl3_SDL_hid_set_nonblocking = Module['_sdl3_SDL_hid_set_nonblocking'] = wasmExports['sdl3_SDL_hid_set_nonblocking'])(a0, a1);
var _sdl3_SDL_hid_write = Module['_sdl3_SDL_hid_write'] = (a0, a1, a2) => (_sdl3_SDL_hid_write = Module['_sdl3_SDL_hid_write'] = wasmExports['sdl3_SDL_hid_write'])(a0, a1, a2);
var _sdl3_SDL_malloc = Module['_sdl3_SDL_malloc'] = (a0) => (_sdl3_SDL_malloc = Module['_sdl3_SDL_malloc'] = wasmExports['sdl3_SDL_malloc'])(a0);
var _SDL3_renamed_SDL_calloc = Module['_SDL3_renamed_SDL_calloc'] = (a0, a1) => (_SDL3_renamed_SDL_calloc = Module['_SDL3_renamed_SDL_calloc'] = wasmExports['SDL3_renamed_SDL_calloc'])(a0, a1);
var _SDL3_renamed_SDL_free = Module['_SDL3_renamed_SDL_free'] = (a0) => (_SDL3_renamed_SDL_free = Module['_SDL3_renamed_SDL_free'] = wasmExports['SDL3_renamed_SDL_free'])(a0);
var _SDL3_renamed_SDL_malloc = Module['_SDL3_renamed_SDL_malloc'] = (a0) => (_SDL3_renamed_SDL_malloc = Module['_SDL3_renamed_SDL_malloc'] = wasmExports['SDL3_renamed_SDL_malloc'])(a0);
var _SDL3_renamed_SDL_realloc = Module['_SDL3_renamed_SDL_realloc'] = (a0, a1) => (_SDL3_renamed_SDL_realloc = Module['_SDL3_renamed_SDL_realloc'] = wasmExports['SDL3_renamed_SDL_realloc'])(a0, a1);
var _SDL3_renamed_Emscripten_force_free = Module['_SDL3_renamed_Emscripten_force_free'] = (a0) => (_SDL3_renamed_Emscripten_force_free = Module['_SDL3_renamed_Emscripten_force_free'] = wasmExports['SDL3_renamed_Emscripten_force_free'])(a0);
var _free = Module['_free'] = (a0) => (_free = Module['_free'] = wasmExports['free'])(a0);
var _fflush = (a0) => (_fflush = wasmExports['fflush'])(a0);
var _malloc = Module['_malloc'] = (a0) => (_malloc = Module['_malloc'] = wasmExports['malloc'])(a0);
var _calloc = Module['_calloc'] = (a0, a1) => (_calloc = Module['_calloc'] = wasmExports['calloc'])(a0, a1);
var _realloc = Module['_realloc'] = (a0, a1) => (_realloc = Module['_realloc'] = wasmExports['realloc'])(a0, a1);
var _atan = Module['_atan'] = (a0) => (_atan = Module['_atan'] = wasmExports['atan'])(a0);
var _atanf = Module['_atanf'] = (a0) => (_atanf = Module['_atanf'] = wasmExports['atanf'])(a0);
var _atan2 = Module['_atan2'] = (a0, a1) => (_atan2 = Module['_atan2'] = wasmExports['atan2'])(a0, a1);
var _atan2f = Module['_atan2f'] = (a0, a1) => (_atan2f = Module['_atan2f'] = wasmExports['atan2f'])(a0, a1);
var _acos = Module['_acos'] = (a0) => (_acos = Module['_acos'] = wasmExports['acos'])(a0);
var _acosf = Module['_acosf'] = (a0) => (_acosf = Module['_acosf'] = wasmExports['acosf'])(a0);
var _asin = Module['_asin'] = (a0) => (_asin = Module['_asin'] = wasmExports['asin'])(a0);
var _asinf = Module['_asinf'] = (a0) => (_asinf = Module['_asinf'] = wasmExports['asinf'])(a0);
var _cos = Module['_cos'] = (a0) => (_cos = Module['_cos'] = wasmExports['cos'])(a0);
var _cosf = Module['_cosf'] = (a0) => (_cosf = Module['_cosf'] = wasmExports['cosf'])(a0);
var _exp = Module['_exp'] = (a0) => (_exp = Module['_exp'] = wasmExports['exp'])(a0);
var _expf = Module['_expf'] = (a0) => (_expf = Module['_expf'] = wasmExports['expf'])(a0);
var _fmod = Module['_fmod'] = (a0, a1) => (_fmod = Module['_fmod'] = wasmExports['fmod'])(a0, a1);
var _fmodf = Module['_fmodf'] = (a0, a1) => (_fmodf = Module['_fmodf'] = wasmExports['fmodf'])(a0, a1);
var _log = Module['_log'] = (a0) => (_log = Module['_log'] = wasmExports['log'])(a0);
var _logf = Module['_logf'] = (a0) => (_logf = Module['_logf'] = wasmExports['logf'])(a0);
var _log10 = Module['_log10'] = (a0) => (_log10 = Module['_log10'] = wasmExports['log10'])(a0);
var _log10f = Module['_log10f'] = (a0) => (_log10f = Module['_log10f'] = wasmExports['log10f'])(a0);
var _pow = Module['_pow'] = (a0, a1) => (_pow = Module['_pow'] = wasmExports['pow'])(a0, a1);
var _powf = Module['_powf'] = (a0, a1) => (_powf = Module['_powf'] = wasmExports['powf'])(a0, a1);
var _sin = Module['_sin'] = (a0) => (_sin = Module['_sin'] = wasmExports['sin'])(a0);
var _sinf = Module['_sinf'] = (a0) => (_sinf = Module['_sinf'] = wasmExports['sinf'])(a0);
var _tan = Module['_tan'] = (a0) => (_tan = Module['_tan'] = wasmExports['tan'])(a0);
var _tanf = Module['_tanf'] = (a0) => (_tanf = Module['_tanf'] = wasmExports['tanf'])(a0);
var _SDL3_renamed_SDLEmscriptenCameraPermissionOutcome = Module['_SDL3_renamed_SDLEmscriptenCameraPermissionOutcome'] = (a0, a1, a2, a3, a4) => (_SDL3_renamed_SDLEmscriptenCameraPermissionOutcome = Module['_SDL3_renamed_SDLEmscriptenCameraPermissionOutcome'] = wasmExports['SDL3_renamed_SDLEmscriptenCameraPermissionOutcome'])(a0, a1, a2, a3, a4);
var _SDL3_renamed_SDLEmscriptenThreadIterate = Module['_SDL3_renamed_SDLEmscriptenThreadIterate'] = (a0) => (_SDL3_renamed_SDLEmscriptenThreadIterate = Module['_SDL3_renamed_SDLEmscriptenThreadIterate'] = wasmExports['SDL3_renamed_SDLEmscriptenThreadIterate'])(a0);
var _SDL3_renamed_Emscripten_HandlePointerEnter = Module['_SDL3_renamed_Emscripten_HandlePointerEnter'] = (a0, a1) => (_SDL3_renamed_Emscripten_HandlePointerEnter = Module['_SDL3_renamed_Emscripten_HandlePointerEnter'] = wasmExports['SDL3_renamed_Emscripten_HandlePointerEnter'])(a0, a1);
var _SDL3_renamed_Emscripten_HandlePointerLeave = Module['_SDL3_renamed_Emscripten_HandlePointerLeave'] = (a0, a1) => (_SDL3_renamed_Emscripten_HandlePointerLeave = Module['_SDL3_renamed_Emscripten_HandlePointerLeave'] = wasmExports['SDL3_renamed_Emscripten_HandlePointerLeave'])(a0, a1);
var _SDL3_renamed_Emscripten_HandlePointerGeneric = Module['_SDL3_renamed_Emscripten_HandlePointerGeneric'] = (a0, a1) => (_SDL3_renamed_Emscripten_HandlePointerGeneric = Module['_SDL3_renamed_Emscripten_HandlePointerGeneric'] = wasmExports['SDL3_renamed_Emscripten_HandlePointerGeneric'])(a0, a1);
var _SDL3_renamed_Emscripten_HandleMouseButtonUpGlobal = Module['_SDL3_renamed_Emscripten_HandleMouseButtonUpGlobal'] = (a0, a1) => (_SDL3_renamed_Emscripten_HandleMouseButtonUpGlobal = Module['_SDL3_renamed_Emscripten_HandleMouseButtonUpGlobal'] = wasmExports['SDL3_renamed_Emscripten_HandleMouseButtonUpGlobal'])(a0, a1);
var _SDL3_renamed_Emscripten_SendDragEvent = Module['_SDL3_renamed_Emscripten_SendDragEvent'] = (a0, a1) => (_SDL3_renamed_Emscripten_SendDragEvent = Module['_SDL3_renamed_Emscripten_SendDragEvent'] = wasmExports['SDL3_renamed_Emscripten_SendDragEvent'])(a0, a1);
var _SDL3_renamed_Emscripten_SendDragCompleteEvent = Module['_SDL3_renamed_Emscripten_SendDragCompleteEvent'] = (a0) => (_SDL3_renamed_Emscripten_SendDragCompleteEvent = Module['_SDL3_renamed_Emscripten_SendDragCompleteEvent'] = wasmExports['SDL3_renamed_Emscripten_SendDragCompleteEvent'])(a0);
var _SDL3_renamed_Emscripten_SendDragTextEvent = Module['_SDL3_renamed_Emscripten_SendDragTextEvent'] = (a0, a1) => (_SDL3_renamed_Emscripten_SendDragTextEvent = Module['_SDL3_renamed_Emscripten_SendDragTextEvent'] = wasmExports['SDL3_renamed_Emscripten_SendDragTextEvent'])(a0, a1);
var _SDL3_renamed_Emscripten_SendDragFileEvent = Module['_SDL3_renamed_Emscripten_SendDragFileEvent'] = (a0, a1) => (_SDL3_renamed_Emscripten_SendDragFileEvent = Module['_SDL3_renamed_Emscripten_SendDragFileEvent'] = wasmExports['SDL3_renamed_Emscripten_SendDragFileEvent'])(a0, a1);
var _SDL3_renamed_Emscripten_HandleLockKeysCheck = Module['_SDL3_renamed_Emscripten_HandleLockKeysCheck'] = (a0, a1, a2, a3) => (_SDL3_renamed_Emscripten_HandleLockKeysCheck = Module['_SDL3_renamed_Emscripten_HandleLockKeysCheck'] = wasmExports['SDL3_renamed_Emscripten_HandleLockKeysCheck'])(a0, a1, a2, a3);
var _SDL3_renamed_Emscripten_SendSystemThemeChangedEvent = Module['_SDL3_renamed_Emscripten_SendSystemThemeChangedEvent'] = () => (_SDL3_renamed_Emscripten_SendSystemThemeChangedEvent = Module['_SDL3_renamed_Emscripten_SendSystemThemeChangedEvent'] = wasmExports['SDL3_renamed_Emscripten_SendSystemThemeChangedEvent'])();
var _SDL3_renamed_requestFullscreenThroughSDL = Module['_SDL3_renamed_requestFullscreenThroughSDL'] = (a0) => (_SDL3_renamed_requestFullscreenThroughSDL = Module['_SDL3_renamed_requestFullscreenThroughSDL'] = wasmExports['SDL3_renamed_requestFullscreenThroughSDL'])(a0);
var _pthread_self = Module['_pthread_self'] = () => (_pthread_self = Module['_pthread_self'] = wasmExports['pthread_self'])();
var _Initialize = Module['_Initialize'] = (a0, a1, a2) => (_Initialize = Module['_Initialize'] = wasmExports['Initialize'])(a0, a1, a2);
var _memset = Module['_memset'] = (a0, a1, a2) => (_memset = Module['_memset'] = wasmExports['memset'])(a0, a1, a2);
var _mono_wasm_register_root = Module['_mono_wasm_register_root'] = (a0, a1, a2) => (_mono_wasm_register_root = Module['_mono_wasm_register_root'] = wasmExports['mono_wasm_register_root'])(a0, a1, a2);
var _mono_wasm_deregister_root = Module['_mono_wasm_deregister_root'] = (a0) => (_mono_wasm_deregister_root = Module['_mono_wasm_deregister_root'] = wasmExports['mono_wasm_deregister_root'])(a0);
var _mono_wasm_add_assembly = Module['_mono_wasm_add_assembly'] = (a0, a1, a2) => (_mono_wasm_add_assembly = Module['_mono_wasm_add_assembly'] = wasmExports['mono_wasm_add_assembly'])(a0, a1, a2);
var _mono_wasm_add_satellite_assembly = Module['_mono_wasm_add_satellite_assembly'] = (a0, a1, a2, a3) => (_mono_wasm_add_satellite_assembly = Module['_mono_wasm_add_satellite_assembly'] = wasmExports['mono_wasm_add_satellite_assembly'])(a0, a1, a2, a3);
var _mono_wasm_setenv = Module['_mono_wasm_setenv'] = (a0, a1) => (_mono_wasm_setenv = Module['_mono_wasm_setenv'] = wasmExports['mono_wasm_setenv'])(a0, a1);
var _mono_wasm_getenv = Module['_mono_wasm_getenv'] = (a0) => (_mono_wasm_getenv = Module['_mono_wasm_getenv'] = wasmExports['mono_wasm_getenv'])(a0);
var _mono_wasm_load_runtime = Module['_mono_wasm_load_runtime'] = (a0, a1, a2, a3) => (_mono_wasm_load_runtime = Module['_mono_wasm_load_runtime'] = wasmExports['mono_wasm_load_runtime'])(a0, a1, a2, a3);
var _mono_wasm_invoke_jsexport = Module['_mono_wasm_invoke_jsexport'] = (a0, a1) => (_mono_wasm_invoke_jsexport = Module['_mono_wasm_invoke_jsexport'] = wasmExports['mono_wasm_invoke_jsexport'])(a0, a1);
var _mono_wasm_print_thread_dump = Module['_mono_wasm_print_thread_dump'] = () => (_mono_wasm_print_thread_dump = Module['_mono_wasm_print_thread_dump'] = wasmExports['mono_wasm_print_thread_dump'])();
var _mono_wasm_invoke_jsexport_async_post = Module['_mono_wasm_invoke_jsexport_async_post'] = (a0, a1, a2) => (_mono_wasm_invoke_jsexport_async_post = Module['_mono_wasm_invoke_jsexport_async_post'] = wasmExports['mono_wasm_invoke_jsexport_async_post'])(a0, a1, a2);
var _mono_wasm_invoke_jsexport_sync = Module['_mono_wasm_invoke_jsexport_sync'] = (a0, a1) => (_mono_wasm_invoke_jsexport_sync = Module['_mono_wasm_invoke_jsexport_sync'] = wasmExports['mono_wasm_invoke_jsexport_sync'])(a0, a1);
var _mono_wasm_invoke_jsexport_sync_send = Module['_mono_wasm_invoke_jsexport_sync_send'] = (a0, a1, a2) => (_mono_wasm_invoke_jsexport_sync_send = Module['_mono_wasm_invoke_jsexport_sync_send'] = wasmExports['mono_wasm_invoke_jsexport_sync_send'])(a0, a1, a2);
var _mono_wasm_synchronization_context_pump = Module['_mono_wasm_synchronization_context_pump'] = () => (_mono_wasm_synchronization_context_pump = Module['_mono_wasm_synchronization_context_pump'] = wasmExports['mono_wasm_synchronization_context_pump'])();
var _mono_wasm_string_from_utf16_ref = Module['_mono_wasm_string_from_utf16_ref'] = (a0, a1, a2) => (_mono_wasm_string_from_utf16_ref = Module['_mono_wasm_string_from_utf16_ref'] = wasmExports['mono_wasm_string_from_utf16_ref'])(a0, a1, a2);
var _mono_wasm_exec_regression = Module['_mono_wasm_exec_regression'] = (a0, a1) => (_mono_wasm_exec_regression = Module['_mono_wasm_exec_regression'] = wasmExports['mono_wasm_exec_regression'])(a0, a1);
var _mono_wasm_exit = Module['_mono_wasm_exit'] = (a0) => (_mono_wasm_exit = Module['_mono_wasm_exit'] = wasmExports['mono_wasm_exit'])(a0);
var _mono_wasm_set_main_args = Module['_mono_wasm_set_main_args'] = (a0, a1) => (_mono_wasm_set_main_args = Module['_mono_wasm_set_main_args'] = wasmExports['mono_wasm_set_main_args'])(a0, a1);
var _mono_wasm_strdup = Module['_mono_wasm_strdup'] = (a0) => (_mono_wasm_strdup = Module['_mono_wasm_strdup'] = wasmExports['mono_wasm_strdup'])(a0);
var _mono_wasm_parse_runtime_options = Module['_mono_wasm_parse_runtime_options'] = (a0, a1) => (_mono_wasm_parse_runtime_options = Module['_mono_wasm_parse_runtime_options'] = wasmExports['mono_wasm_parse_runtime_options'])(a0, a1);
var _mono_wasm_intern_string_ref = Module['_mono_wasm_intern_string_ref'] = (a0) => (_mono_wasm_intern_string_ref = Module['_mono_wasm_intern_string_ref'] = wasmExports['mono_wasm_intern_string_ref'])(a0);
var _mono_wasm_string_get_data_ref = Module['_mono_wasm_string_get_data_ref'] = (a0, a1, a2, a3) => (_mono_wasm_string_get_data_ref = Module['_mono_wasm_string_get_data_ref'] = wasmExports['mono_wasm_string_get_data_ref'])(a0, a1, a2, a3);
var _mono_wasm_write_managed_pointer_unsafe = Module['_mono_wasm_write_managed_pointer_unsafe'] = (a0, a1) => (_mono_wasm_write_managed_pointer_unsafe = Module['_mono_wasm_write_managed_pointer_unsafe'] = wasmExports['mono_wasm_write_managed_pointer_unsafe'])(a0, a1);
var _mono_wasm_copy_managed_pointer = Module['_mono_wasm_copy_managed_pointer'] = (a0, a1) => (_mono_wasm_copy_managed_pointer = Module['_mono_wasm_copy_managed_pointer'] = wasmExports['mono_wasm_copy_managed_pointer'])(a0, a1);
var _mono_wasm_init_finalizer_thread = Module['_mono_wasm_init_finalizer_thread'] = () => (_mono_wasm_init_finalizer_thread = Module['_mono_wasm_init_finalizer_thread'] = wasmExports['mono_wasm_init_finalizer_thread'])();
var _mono_wasm_i52_to_f64 = Module['_mono_wasm_i52_to_f64'] = (a0, a1) => (_mono_wasm_i52_to_f64 = Module['_mono_wasm_i52_to_f64'] = wasmExports['mono_wasm_i52_to_f64'])(a0, a1);
var _mono_wasm_u52_to_f64 = Module['_mono_wasm_u52_to_f64'] = (a0, a1) => (_mono_wasm_u52_to_f64 = Module['_mono_wasm_u52_to_f64'] = wasmExports['mono_wasm_u52_to_f64'])(a0, a1);
var _mono_wasm_f64_to_u52 = Module['_mono_wasm_f64_to_u52'] = (a0, a1) => (_mono_wasm_f64_to_u52 = Module['_mono_wasm_f64_to_u52'] = wasmExports['mono_wasm_f64_to_u52'])(a0, a1);
var _mono_wasm_f64_to_i52 = Module['_mono_wasm_f64_to_i52'] = (a0, a1) => (_mono_wasm_f64_to_i52 = Module['_mono_wasm_f64_to_i52'] = wasmExports['mono_wasm_f64_to_i52'])(a0, a1);
var _mono_wasm_method_get_full_name = Module['_mono_wasm_method_get_full_name'] = (a0) => (_mono_wasm_method_get_full_name = Module['_mono_wasm_method_get_full_name'] = wasmExports['mono_wasm_method_get_full_name'])(a0);
var _mono_wasm_method_get_name = Module['_mono_wasm_method_get_name'] = (a0) => (_mono_wasm_method_get_name = Module['_mono_wasm_method_get_name'] = wasmExports['mono_wasm_method_get_name'])(a0);
var _mono_wasm_method_get_name_ex = Module['_mono_wasm_method_get_name_ex'] = (a0) => (_mono_wasm_method_get_name_ex = Module['_mono_wasm_method_get_name_ex'] = wasmExports['mono_wasm_method_get_name_ex'])(a0);
var _mono_wasm_get_f32_unaligned = Module['_mono_wasm_get_f32_unaligned'] = (a0) => (_mono_wasm_get_f32_unaligned = Module['_mono_wasm_get_f32_unaligned'] = wasmExports['mono_wasm_get_f32_unaligned'])(a0);
var _mono_wasm_get_f64_unaligned = Module['_mono_wasm_get_f64_unaligned'] = (a0) => (_mono_wasm_get_f64_unaligned = Module['_mono_wasm_get_f64_unaligned'] = wasmExports['mono_wasm_get_f64_unaligned'])(a0);
var _mono_wasm_get_i32_unaligned = Module['_mono_wasm_get_i32_unaligned'] = (a0) => (_mono_wasm_get_i32_unaligned = Module['_mono_wasm_get_i32_unaligned'] = wasmExports['mono_wasm_get_i32_unaligned'])(a0);
var _mono_wasm_is_zero_page_reserved = Module['_mono_wasm_is_zero_page_reserved'] = () => (_mono_wasm_is_zero_page_reserved = Module['_mono_wasm_is_zero_page_reserved'] = wasmExports['mono_wasm_is_zero_page_reserved'])();
var _mono_wasm_read_as_bool_or_null_unsafe = Module['_mono_wasm_read_as_bool_or_null_unsafe'] = (a0) => (_mono_wasm_read_as_bool_or_null_unsafe = Module['_mono_wasm_read_as_bool_or_null_unsafe'] = wasmExports['mono_wasm_read_as_bool_or_null_unsafe'])(a0);
var _mono_wasm_assembly_load = Module['_mono_wasm_assembly_load'] = (a0) => (_mono_wasm_assembly_load = Module['_mono_wasm_assembly_load'] = wasmExports['mono_wasm_assembly_load'])(a0);
var _mono_wasm_assembly_find_class = Module['_mono_wasm_assembly_find_class'] = (a0, a1, a2) => (_mono_wasm_assembly_find_class = Module['_mono_wasm_assembly_find_class'] = wasmExports['mono_wasm_assembly_find_class'])(a0, a1, a2);
var _mono_wasm_assembly_find_method = Module['_mono_wasm_assembly_find_method'] = (a0, a1, a2) => (_mono_wasm_assembly_find_method = Module['_mono_wasm_assembly_find_method'] = wasmExports['mono_wasm_assembly_find_method'])(a0, a1, a2);
var _mono_aot_classicuo_wasm_get_method = Module['_mono_aot_classicuo_wasm_get_method'] = (a0) => (_mono_aot_classicuo_wasm_get_method = Module['_mono_aot_classicuo_wasm_get_method'] = wasmExports['mono_aot_classicuo_wasm_get_method'])(a0);
var _mono_aot_System_Collections_Concurrent_get_method = Module['_mono_aot_System_Collections_Concurrent_get_method'] = (a0) => (_mono_aot_System_Collections_Concurrent_get_method = Module['_mono_aot_System_Collections_Concurrent_get_method'] = wasmExports['mono_aot_System_Collections_Concurrent_get_method'])(a0);
var _mono_aot_System_Collections_get_method = Module['_mono_aot_System_Collections_get_method'] = (a0) => (_mono_aot_System_Collections_get_method = Module['_mono_aot_System_Collections_get_method'] = wasmExports['mono_aot_System_Collections_get_method'])(a0);
var _mono_aot_System_IO_Compression_Brotli_get_method = Module['_mono_aot_System_IO_Compression_Brotli_get_method'] = (a0) => (_mono_aot_System_IO_Compression_Brotli_get_method = Module['_mono_aot_System_IO_Compression_Brotli_get_method'] = wasmExports['mono_aot_System_IO_Compression_Brotli_get_method'])(a0);
var _mono_aot_System_IO_Compression_get_method = Module['_mono_aot_System_IO_Compression_get_method'] = (a0) => (_mono_aot_System_IO_Compression_get_method = Module['_mono_aot_System_IO_Compression_get_method'] = wasmExports['mono_aot_System_IO_Compression_get_method'])(a0);
var _mono_aot_System_Memory_get_method = Module['_mono_aot_System_Memory_get_method'] = (a0) => (_mono_aot_System_Memory_get_method = Module['_mono_aot_System_Memory_get_method'] = wasmExports['mono_aot_System_Memory_get_method'])(a0);
var _mono_aot_System_Numerics_Vectors_get_method = Module['_mono_aot_System_Numerics_Vectors_get_method'] = (a0) => (_mono_aot_System_Numerics_Vectors_get_method = Module['_mono_aot_System_Numerics_Vectors_get_method'] = wasmExports['mono_aot_System_Numerics_Vectors_get_method'])(a0);
var _mono_aot_System_Runtime_get_method = Module['_mono_aot_System_Runtime_get_method'] = (a0) => (_mono_aot_System_Runtime_get_method = Module['_mono_aot_System_Runtime_get_method'] = wasmExports['mono_aot_System_Runtime_get_method'])(a0);
var _mono_aot_mscorlib_get_method = Module['_mono_aot_mscorlib_get_method'] = (a0) => (_mono_aot_mscorlib_get_method = Module['_mono_aot_mscorlib_get_method'] = wasmExports['mono_aot_mscorlib_get_method'])(a0);
var _mono_aot_netstandard_get_method = Module['_mono_aot_netstandard_get_method'] = (a0) => (_mono_aot_netstandard_get_method = Module['_mono_aot_netstandard_get_method'] = wasmExports['mono_aot_netstandard_get_method'])(a0);
var _log2 = Module['_log2'] = (a0) => (_log2 = Module['_log2'] = wasmExports['log2'])(a0);
var _fma = Module['_fma'] = (a0, a1, a2) => (_fma = Module['_fma'] = wasmExports['fma'])(a0, a1, a2);
var _log2f = Module['_log2f'] = (a0) => (_log2f = Module['_log2f'] = wasmExports['log2f'])(a0);
var _fmaf = Module['_fmaf'] = (a0, a1, a2) => (_fmaf = Module['_fmaf'] = wasmExports['fmaf'])(a0, a1, a2);
var _mono_aot_corlib_get_method = Module['_mono_aot_corlib_get_method'] = (a0) => (_mono_aot_corlib_get_method = Module['_mono_aot_corlib_get_method'] = wasmExports['mono_aot_corlib_get_method'])(a0);
var _mono_aot_ClassicUO_Assets_get_method = Module['_mono_aot_ClassicUO_Assets_get_method'] = (a0) => (_mono_aot_ClassicUO_Assets_get_method = Module['_mono_aot_ClassicUO_Assets_get_method'] = wasmExports['mono_aot_ClassicUO_Assets_get_method'])(a0);
var _mono_aot_ClassicUO_IO_get_method = Module['_mono_aot_ClassicUO_IO_get_method'] = (a0) => (_mono_aot_ClassicUO_IO_get_method = Module['_mono_aot_ClassicUO_IO_get_method'] = wasmExports['mono_aot_ClassicUO_IO_get_method'])(a0);
var _mono_aot_ClassicUO_Renderer_get_method = Module['_mono_aot_ClassicUO_Renderer_get_method'] = (a0) => (_mono_aot_ClassicUO_Renderer_get_method = Module['_mono_aot_ClassicUO_Renderer_get_method'] = wasmExports['mono_aot_ClassicUO_Renderer_get_method'])(a0);
var _mono_aot_ClassicUO_Utility_get_method = Module['_mono_aot_ClassicUO_Utility_get_method'] = (a0) => (_mono_aot_ClassicUO_Utility_get_method = Module['_mono_aot_ClassicUO_Utility_get_method'] = wasmExports['mono_aot_ClassicUO_Utility_get_method'])(a0);
var _mono_aot_cuo_get_method = Module['_mono_aot_cuo_get_method'] = (a0) => (_mono_aot_cuo_get_method = Module['_mono_aot_cuo_get_method'] = wasmExports['mono_aot_cuo_get_method'])(a0);
var _mono_aot_FNA_get_method = Module['_mono_aot_FNA_get_method'] = (a0) => (_mono_aot_FNA_get_method = Module['_mono_aot_FNA_get_method'] = wasmExports['mono_aot_FNA_get_method'])(a0);
var _mono_wasm_send_dbg_command_with_parms = Module['_mono_wasm_send_dbg_command_with_parms'] = (a0, a1, a2, a3, a4, a5, a6) => (_mono_wasm_send_dbg_command_with_parms = Module['_mono_wasm_send_dbg_command_with_parms'] = wasmExports['mono_wasm_send_dbg_command_with_parms'])(a0, a1, a2, a3, a4, a5, a6);
var _mono_wasm_send_dbg_command = Module['_mono_wasm_send_dbg_command'] = (a0, a1, a2, a3, a4) => (_mono_wasm_send_dbg_command = Module['_mono_wasm_send_dbg_command'] = wasmExports['mono_wasm_send_dbg_command'])(a0, a1, a2, a3, a4);
var _mono_jiterp_register_jit_call_thunk = Module['_mono_jiterp_register_jit_call_thunk'] = (a0, a1) => (_mono_jiterp_register_jit_call_thunk = Module['_mono_jiterp_register_jit_call_thunk'] = wasmExports['mono_jiterp_register_jit_call_thunk'])(a0, a1);
var _mono_jiterp_stackval_to_data = Module['_mono_jiterp_stackval_to_data'] = (a0, a1, a2) => (_mono_jiterp_stackval_to_data = Module['_mono_jiterp_stackval_to_data'] = wasmExports['mono_jiterp_stackval_to_data'])(a0, a1, a2);
var _mono_jiterp_stackval_from_data = Module['_mono_jiterp_stackval_from_data'] = (a0, a1, a2) => (_mono_jiterp_stackval_from_data = Module['_mono_jiterp_stackval_from_data'] = wasmExports['mono_jiterp_stackval_from_data'])(a0, a1, a2);
var _mono_jiterp_get_arg_offset = Module['_mono_jiterp_get_arg_offset'] = (a0, a1, a2) => (_mono_jiterp_get_arg_offset = Module['_mono_jiterp_get_arg_offset'] = wasmExports['mono_jiterp_get_arg_offset'])(a0, a1, a2);
var _mono_jiterp_overflow_check_i4 = Module['_mono_jiterp_overflow_check_i4'] = (a0, a1, a2) => (_mono_jiterp_overflow_check_i4 = Module['_mono_jiterp_overflow_check_i4'] = wasmExports['mono_jiterp_overflow_check_i4'])(a0, a1, a2);
var _mono_jiterp_overflow_check_u4 = Module['_mono_jiterp_overflow_check_u4'] = (a0, a1, a2) => (_mono_jiterp_overflow_check_u4 = Module['_mono_jiterp_overflow_check_u4'] = wasmExports['mono_jiterp_overflow_check_u4'])(a0, a1, a2);
var _mono_jiterp_ld_delegate_method_ptr = Module['_mono_jiterp_ld_delegate_method_ptr'] = (a0, a1) => (_mono_jiterp_ld_delegate_method_ptr = Module['_mono_jiterp_ld_delegate_method_ptr'] = wasmExports['mono_jiterp_ld_delegate_method_ptr'])(a0, a1);
var _mono_jiterp_interp_entry = Module['_mono_jiterp_interp_entry'] = (a0, a1) => (_mono_jiterp_interp_entry = Module['_mono_jiterp_interp_entry'] = wasmExports['mono_jiterp_interp_entry'])(a0, a1);
var _asinh = Module['_asinh'] = (a0) => (_asinh = Module['_asinh'] = wasmExports['asinh'])(a0);
var _acosh = Module['_acosh'] = (a0) => (_acosh = Module['_acosh'] = wasmExports['acosh'])(a0);
var _atanh = Module['_atanh'] = (a0) => (_atanh = Module['_atanh'] = wasmExports['atanh'])(a0);
var _cbrt = Module['_cbrt'] = (a0) => (_cbrt = Module['_cbrt'] = wasmExports['cbrt'])(a0);
var _cosh = Module['_cosh'] = (a0) => (_cosh = Module['_cosh'] = wasmExports['cosh'])(a0);
var _sinh = Module['_sinh'] = (a0) => (_sinh = Module['_sinh'] = wasmExports['sinh'])(a0);
var _tanh = Module['_tanh'] = (a0) => (_tanh = Module['_tanh'] = wasmExports['tanh'])(a0);
var _asinhf = Module['_asinhf'] = (a0) => (_asinhf = Module['_asinhf'] = wasmExports['asinhf'])(a0);
var _acoshf = Module['_acoshf'] = (a0) => (_acoshf = Module['_acoshf'] = wasmExports['acoshf'])(a0);
var _atanhf = Module['_atanhf'] = (a0) => (_atanhf = Module['_atanhf'] = wasmExports['atanhf'])(a0);
var _cbrtf = Module['_cbrtf'] = (a0) => (_cbrtf = Module['_cbrtf'] = wasmExports['cbrtf'])(a0);
var _coshf = Module['_coshf'] = (a0) => (_coshf = Module['_coshf'] = wasmExports['coshf'])(a0);
var _sinhf = Module['_sinhf'] = (a0) => (_sinhf = Module['_sinhf'] = wasmExports['sinhf'])(a0);
var _tanhf = Module['_tanhf'] = (a0) => (_tanhf = Module['_tanhf'] = wasmExports['tanhf'])(a0);
var _mono_jiterp_get_polling_required_address = Module['_mono_jiterp_get_polling_required_address'] = () => (_mono_jiterp_get_polling_required_address = Module['_mono_jiterp_get_polling_required_address'] = wasmExports['mono_jiterp_get_polling_required_address'])();
var _mono_jiterp_prof_enter = Module['_mono_jiterp_prof_enter'] = (a0, a1) => (_mono_jiterp_prof_enter = Module['_mono_jiterp_prof_enter'] = wasmExports['mono_jiterp_prof_enter'])(a0, a1);
var _mono_jiterp_prof_samplepoint = Module['_mono_jiterp_prof_samplepoint'] = (a0, a1) => (_mono_jiterp_prof_samplepoint = Module['_mono_jiterp_prof_samplepoint'] = wasmExports['mono_jiterp_prof_samplepoint'])(a0, a1);
var _mono_jiterp_prof_leave = Module['_mono_jiterp_prof_leave'] = (a0, a1) => (_mono_jiterp_prof_leave = Module['_mono_jiterp_prof_leave'] = wasmExports['mono_jiterp_prof_leave'])(a0, a1);
var _mono_jiterp_do_safepoint = Module['_mono_jiterp_do_safepoint'] = (a0, a1) => (_mono_jiterp_do_safepoint = Module['_mono_jiterp_do_safepoint'] = wasmExports['mono_jiterp_do_safepoint'])(a0, a1);
var _mono_jiterp_imethod_to_ftnptr = Module['_mono_jiterp_imethod_to_ftnptr'] = (a0) => (_mono_jiterp_imethod_to_ftnptr = Module['_mono_jiterp_imethod_to_ftnptr'] = wasmExports['mono_jiterp_imethod_to_ftnptr'])(a0);
var _mono_jiterp_enum_hasflag = Module['_mono_jiterp_enum_hasflag'] = (a0, a1, a2, a3) => (_mono_jiterp_enum_hasflag = Module['_mono_jiterp_enum_hasflag'] = wasmExports['mono_jiterp_enum_hasflag'])(a0, a1, a2, a3);
var _mono_jiterp_get_simd_intrinsic = Module['_mono_jiterp_get_simd_intrinsic'] = (a0, a1) => (_mono_jiterp_get_simd_intrinsic = Module['_mono_jiterp_get_simd_intrinsic'] = wasmExports['mono_jiterp_get_simd_intrinsic'])(a0, a1);
var _mono_jiterp_get_simd_opcode = Module['_mono_jiterp_get_simd_opcode'] = (a0, a1) => (_mono_jiterp_get_simd_opcode = Module['_mono_jiterp_get_simd_opcode'] = wasmExports['mono_jiterp_get_simd_opcode'])(a0, a1);
var _mono_jiterp_get_opcode_info = Module['_mono_jiterp_get_opcode_info'] = (a0, a1) => (_mono_jiterp_get_opcode_info = Module['_mono_jiterp_get_opcode_info'] = wasmExports['mono_jiterp_get_opcode_info'])(a0, a1);
var _mono_jiterp_placeholder_trace = Module['_mono_jiterp_placeholder_trace'] = (a0, a1, a2, a3) => (_mono_jiterp_placeholder_trace = Module['_mono_jiterp_placeholder_trace'] = wasmExports['mono_jiterp_placeholder_trace'])(a0, a1, a2, a3);
var _mono_jiterp_placeholder_jit_call = Module['_mono_jiterp_placeholder_jit_call'] = (a0, a1, a2, a3) => (_mono_jiterp_placeholder_jit_call = Module['_mono_jiterp_placeholder_jit_call'] = wasmExports['mono_jiterp_placeholder_jit_call'])(a0, a1, a2, a3);
var _mono_jiterp_get_interp_entry_func = Module['_mono_jiterp_get_interp_entry_func'] = (a0) => (_mono_jiterp_get_interp_entry_func = Module['_mono_jiterp_get_interp_entry_func'] = wasmExports['mono_jiterp_get_interp_entry_func'])(a0);
var _mono_jiterp_is_enabled = Module['_mono_jiterp_is_enabled'] = () => (_mono_jiterp_is_enabled = Module['_mono_jiterp_is_enabled'] = wasmExports['mono_jiterp_is_enabled'])();
var _mono_jiterp_encode_leb64_ref = Module['_mono_jiterp_encode_leb64_ref'] = (a0, a1, a2) => (_mono_jiterp_encode_leb64_ref = Module['_mono_jiterp_encode_leb64_ref'] = wasmExports['mono_jiterp_encode_leb64_ref'])(a0, a1, a2);
var _mono_jiterp_encode_leb52 = Module['_mono_jiterp_encode_leb52'] = (a0, a1, a2) => (_mono_jiterp_encode_leb52 = Module['_mono_jiterp_encode_leb52'] = wasmExports['mono_jiterp_encode_leb52'])(a0, a1, a2);
var _mono_jiterp_encode_leb_signed_boundary = Module['_mono_jiterp_encode_leb_signed_boundary'] = (a0, a1, a2) => (_mono_jiterp_encode_leb_signed_boundary = Module['_mono_jiterp_encode_leb_signed_boundary'] = wasmExports['mono_jiterp_encode_leb_signed_boundary'])(a0, a1, a2);
var _mono_jiterp_increase_entry_count = Module['_mono_jiterp_increase_entry_count'] = (a0) => (_mono_jiterp_increase_entry_count = Module['_mono_jiterp_increase_entry_count'] = wasmExports['mono_jiterp_increase_entry_count'])(a0);
var _mono_jiterp_object_unbox = Module['_mono_jiterp_object_unbox'] = (a0) => (_mono_jiterp_object_unbox = Module['_mono_jiterp_object_unbox'] = wasmExports['mono_jiterp_object_unbox'])(a0);
var _mono_jiterp_type_is_byref = Module['_mono_jiterp_type_is_byref'] = (a0) => (_mono_jiterp_type_is_byref = Module['_mono_jiterp_type_is_byref'] = wasmExports['mono_jiterp_type_is_byref'])(a0);
var _mono_jiterp_value_copy = Module['_mono_jiterp_value_copy'] = (a0, a1, a2) => (_mono_jiterp_value_copy = Module['_mono_jiterp_value_copy'] = wasmExports['mono_jiterp_value_copy'])(a0, a1, a2);
var _mono_jiterp_try_newobj_inlined = Module['_mono_jiterp_try_newobj_inlined'] = (a0, a1) => (_mono_jiterp_try_newobj_inlined = Module['_mono_jiterp_try_newobj_inlined'] = wasmExports['mono_jiterp_try_newobj_inlined'])(a0, a1);
var _mono_jiterp_try_newstr = Module['_mono_jiterp_try_newstr'] = (a0, a1) => (_mono_jiterp_try_newstr = Module['_mono_jiterp_try_newstr'] = wasmExports['mono_jiterp_try_newstr'])(a0, a1);
var _mono_jiterp_try_newarr = Module['_mono_jiterp_try_newarr'] = (a0, a1, a2) => (_mono_jiterp_try_newarr = Module['_mono_jiterp_try_newarr'] = wasmExports['mono_jiterp_try_newarr'])(a0, a1, a2);
var _mono_jiterp_gettype_ref = Module['_mono_jiterp_gettype_ref'] = (a0, a1) => (_mono_jiterp_gettype_ref = Module['_mono_jiterp_gettype_ref'] = wasmExports['mono_jiterp_gettype_ref'])(a0, a1);
var _mono_jiterp_has_parent_fast = Module['_mono_jiterp_has_parent_fast'] = (a0, a1) => (_mono_jiterp_has_parent_fast = Module['_mono_jiterp_has_parent_fast'] = wasmExports['mono_jiterp_has_parent_fast'])(a0, a1);
var _mono_jiterp_implements_interface = Module['_mono_jiterp_implements_interface'] = (a0, a1) => (_mono_jiterp_implements_interface = Module['_mono_jiterp_implements_interface'] = wasmExports['mono_jiterp_implements_interface'])(a0, a1);
var _mono_jiterp_is_special_interface = Module['_mono_jiterp_is_special_interface'] = (a0) => (_mono_jiterp_is_special_interface = Module['_mono_jiterp_is_special_interface'] = wasmExports['mono_jiterp_is_special_interface'])(a0);
var _mono_jiterp_implements_special_interface = Module['_mono_jiterp_implements_special_interface'] = (a0, a1, a2) => (_mono_jiterp_implements_special_interface = Module['_mono_jiterp_implements_special_interface'] = wasmExports['mono_jiterp_implements_special_interface'])(a0, a1, a2);
var _mono_jiterp_cast_v2 = Module['_mono_jiterp_cast_v2'] = (a0, a1, a2, a3) => (_mono_jiterp_cast_v2 = Module['_mono_jiterp_cast_v2'] = wasmExports['mono_jiterp_cast_v2'])(a0, a1, a2, a3);
var _mono_jiterp_localloc = Module['_mono_jiterp_localloc'] = (a0, a1, a2) => (_mono_jiterp_localloc = Module['_mono_jiterp_localloc'] = wasmExports['mono_jiterp_localloc'])(a0, a1, a2);
var _mono_jiterp_ldtsflda = Module['_mono_jiterp_ldtsflda'] = (a0, a1) => (_mono_jiterp_ldtsflda = Module['_mono_jiterp_ldtsflda'] = wasmExports['mono_jiterp_ldtsflda'])(a0, a1);
var _mono_jiterp_box_ref = Module['_mono_jiterp_box_ref'] = (a0, a1, a2, a3) => (_mono_jiterp_box_ref = Module['_mono_jiterp_box_ref'] = wasmExports['mono_jiterp_box_ref'])(a0, a1, a2, a3);
var _mono_jiterp_conv = Module['_mono_jiterp_conv'] = (a0, a1, a2) => (_mono_jiterp_conv = Module['_mono_jiterp_conv'] = wasmExports['mono_jiterp_conv'])(a0, a1, a2);
var _mono_jiterp_relop_fp = Module['_mono_jiterp_relop_fp'] = (a0, a1, a2) => (_mono_jiterp_relop_fp = Module['_mono_jiterp_relop_fp'] = wasmExports['mono_jiterp_relop_fp'])(a0, a1, a2);
var _mono_jiterp_get_size_of_stackval = Module['_mono_jiterp_get_size_of_stackval'] = () => (_mono_jiterp_get_size_of_stackval = Module['_mono_jiterp_get_size_of_stackval'] = wasmExports['mono_jiterp_get_size_of_stackval'])();
var _mono_jiterp_type_get_raw_value_size = Module['_mono_jiterp_type_get_raw_value_size'] = (a0) => (_mono_jiterp_type_get_raw_value_size = Module['_mono_jiterp_type_get_raw_value_size'] = wasmExports['mono_jiterp_type_get_raw_value_size'])(a0);
var _mono_jiterp_trace_bailout = Module['_mono_jiterp_trace_bailout'] = (a0) => (_mono_jiterp_trace_bailout = Module['_mono_jiterp_trace_bailout'] = wasmExports['mono_jiterp_trace_bailout'])(a0);
var _mono_jiterp_get_trace_bailout_count = Module['_mono_jiterp_get_trace_bailout_count'] = (a0) => (_mono_jiterp_get_trace_bailout_count = Module['_mono_jiterp_get_trace_bailout_count'] = wasmExports['mono_jiterp_get_trace_bailout_count'])(a0);
var _mono_jiterp_adjust_abort_count = Module['_mono_jiterp_adjust_abort_count'] = (a0, a1) => (_mono_jiterp_adjust_abort_count = Module['_mono_jiterp_adjust_abort_count'] = wasmExports['mono_jiterp_adjust_abort_count'])(a0, a1);
var _mono_jiterp_interp_entry_prologue = Module['_mono_jiterp_interp_entry_prologue'] = (a0, a1) => (_mono_jiterp_interp_entry_prologue = Module['_mono_jiterp_interp_entry_prologue'] = wasmExports['mono_jiterp_interp_entry_prologue'])(a0, a1);
var _mono_jiterp_get_opcode_value_table_entry = Module['_mono_jiterp_get_opcode_value_table_entry'] = (a0) => (_mono_jiterp_get_opcode_value_table_entry = Module['_mono_jiterp_get_opcode_value_table_entry'] = wasmExports['mono_jiterp_get_opcode_value_table_entry'])(a0);
var _mono_jiterp_get_trace_hit_count = Module['_mono_jiterp_get_trace_hit_count'] = (a0) => (_mono_jiterp_get_trace_hit_count = Module['_mono_jiterp_get_trace_hit_count'] = wasmExports['mono_jiterp_get_trace_hit_count'])(a0);
var _mono_jiterp_parse_option = Module['_mono_jiterp_parse_option'] = (a0) => (_mono_jiterp_parse_option = Module['_mono_jiterp_parse_option'] = wasmExports['mono_jiterp_parse_option'])(a0);
var _mono_jiterp_get_options_version = Module['_mono_jiterp_get_options_version'] = () => (_mono_jiterp_get_options_version = Module['_mono_jiterp_get_options_version'] = wasmExports['mono_jiterp_get_options_version'])();
var _mono_jiterp_get_options_as_json = Module['_mono_jiterp_get_options_as_json'] = () => (_mono_jiterp_get_options_as_json = Module['_mono_jiterp_get_options_as_json'] = wasmExports['mono_jiterp_get_options_as_json'])();
var _mono_jiterp_get_option_as_int = Module['_mono_jiterp_get_option_as_int'] = (a0) => (_mono_jiterp_get_option_as_int = Module['_mono_jiterp_get_option_as_int'] = wasmExports['mono_jiterp_get_option_as_int'])(a0);
var _mono_jiterp_object_has_component_size = Module['_mono_jiterp_object_has_component_size'] = (a0) => (_mono_jiterp_object_has_component_size = Module['_mono_jiterp_object_has_component_size'] = wasmExports['mono_jiterp_object_has_component_size'])(a0);
var _mono_jiterp_get_hashcode = Module['_mono_jiterp_get_hashcode'] = (a0) => (_mono_jiterp_get_hashcode = Module['_mono_jiterp_get_hashcode'] = wasmExports['mono_jiterp_get_hashcode'])(a0);
var _mono_jiterp_try_get_hashcode = Module['_mono_jiterp_try_get_hashcode'] = (a0) => (_mono_jiterp_try_get_hashcode = Module['_mono_jiterp_try_get_hashcode'] = wasmExports['mono_jiterp_try_get_hashcode'])(a0);
var _mono_jiterp_get_signature_has_this = Module['_mono_jiterp_get_signature_has_this'] = (a0) => (_mono_jiterp_get_signature_has_this = Module['_mono_jiterp_get_signature_has_this'] = wasmExports['mono_jiterp_get_signature_has_this'])(a0);
var _mono_jiterp_get_signature_return_type = Module['_mono_jiterp_get_signature_return_type'] = (a0) => (_mono_jiterp_get_signature_return_type = Module['_mono_jiterp_get_signature_return_type'] = wasmExports['mono_jiterp_get_signature_return_type'])(a0);
var _mono_jiterp_get_signature_param_count = Module['_mono_jiterp_get_signature_param_count'] = (a0) => (_mono_jiterp_get_signature_param_count = Module['_mono_jiterp_get_signature_param_count'] = wasmExports['mono_jiterp_get_signature_param_count'])(a0);
var _mono_jiterp_get_signature_params = Module['_mono_jiterp_get_signature_params'] = (a0) => (_mono_jiterp_get_signature_params = Module['_mono_jiterp_get_signature_params'] = wasmExports['mono_jiterp_get_signature_params'])(a0);
var _mono_jiterp_type_to_ldind = Module['_mono_jiterp_type_to_ldind'] = (a0) => (_mono_jiterp_type_to_ldind = Module['_mono_jiterp_type_to_ldind'] = wasmExports['mono_jiterp_type_to_ldind'])(a0);
var _mono_jiterp_type_to_stind = Module['_mono_jiterp_type_to_stind'] = (a0) => (_mono_jiterp_type_to_stind = Module['_mono_jiterp_type_to_stind'] = wasmExports['mono_jiterp_type_to_stind'])(a0);
var _mono_jiterp_get_array_rank = Module['_mono_jiterp_get_array_rank'] = (a0, a1) => (_mono_jiterp_get_array_rank = Module['_mono_jiterp_get_array_rank'] = wasmExports['mono_jiterp_get_array_rank'])(a0, a1);
var _mono_jiterp_get_array_element_size = Module['_mono_jiterp_get_array_element_size'] = (a0, a1) => (_mono_jiterp_get_array_element_size = Module['_mono_jiterp_get_array_element_size'] = wasmExports['mono_jiterp_get_array_element_size'])(a0, a1);
var _mono_jiterp_set_object_field = Module['_mono_jiterp_set_object_field'] = (a0, a1, a2, a3) => (_mono_jiterp_set_object_field = Module['_mono_jiterp_set_object_field'] = wasmExports['mono_jiterp_set_object_field'])(a0, a1, a2, a3);
var _mono_jiterp_debug_count = Module['_mono_jiterp_debug_count'] = () => (_mono_jiterp_debug_count = Module['_mono_jiterp_debug_count'] = wasmExports['mono_jiterp_debug_count'])();
var _mono_jiterp_stelem_ref = Module['_mono_jiterp_stelem_ref'] = (a0, a1, a2) => (_mono_jiterp_stelem_ref = Module['_mono_jiterp_stelem_ref'] = wasmExports['mono_jiterp_stelem_ref'])(a0, a1, a2);
var _mono_jiterp_get_member_offset = Module['_mono_jiterp_get_member_offset'] = (a0) => (_mono_jiterp_get_member_offset = Module['_mono_jiterp_get_member_offset'] = wasmExports['mono_jiterp_get_member_offset'])(a0);
var _mono_jiterp_get_counter = Module['_mono_jiterp_get_counter'] = (a0) => (_mono_jiterp_get_counter = Module['_mono_jiterp_get_counter'] = wasmExports['mono_jiterp_get_counter'])(a0);
var _mono_jiterp_modify_counter = Module['_mono_jiterp_modify_counter'] = (a0, a1) => (_mono_jiterp_modify_counter = Module['_mono_jiterp_modify_counter'] = wasmExports['mono_jiterp_modify_counter'])(a0, a1);
var _mono_jiterp_write_number_unaligned = Module['_mono_jiterp_write_number_unaligned'] = (a0, a1, a2) => (_mono_jiterp_write_number_unaligned = Module['_mono_jiterp_write_number_unaligned'] = wasmExports['mono_jiterp_write_number_unaligned'])(a0, a1, a2);
var _mono_jiterp_get_rejected_trace_count = Module['_mono_jiterp_get_rejected_trace_count'] = () => (_mono_jiterp_get_rejected_trace_count = Module['_mono_jiterp_get_rejected_trace_count'] = wasmExports['mono_jiterp_get_rejected_trace_count'])();
var _mono_jiterp_boost_back_branch_target = Module['_mono_jiterp_boost_back_branch_target'] = (a0) => (_mono_jiterp_boost_back_branch_target = Module['_mono_jiterp_boost_back_branch_target'] = wasmExports['mono_jiterp_boost_back_branch_target'])(a0);
var _mono_jiterp_is_imethod_var_address_taken = Module['_mono_jiterp_is_imethod_var_address_taken'] = (a0, a1) => (_mono_jiterp_is_imethod_var_address_taken = Module['_mono_jiterp_is_imethod_var_address_taken'] = wasmExports['mono_jiterp_is_imethod_var_address_taken'])(a0, a1);
var _mono_jiterp_initialize_table = Module['_mono_jiterp_initialize_table'] = (a0, a1, a2) => (_mono_jiterp_initialize_table = Module['_mono_jiterp_initialize_table'] = wasmExports['mono_jiterp_initialize_table'])(a0, a1, a2);
var _mono_jiterp_allocate_table_entry = Module['_mono_jiterp_allocate_table_entry'] = (a0) => (_mono_jiterp_allocate_table_entry = Module['_mono_jiterp_allocate_table_entry'] = wasmExports['mono_jiterp_allocate_table_entry'])(a0);
var _mono_jiterp_tlqueue_next = Module['_mono_jiterp_tlqueue_next'] = (a0) => (_mono_jiterp_tlqueue_next = Module['_mono_jiterp_tlqueue_next'] = wasmExports['mono_jiterp_tlqueue_next'])(a0);
var _mono_jiterp_tlqueue_add = Module['_mono_jiterp_tlqueue_add'] = (a0, a1) => (_mono_jiterp_tlqueue_add = Module['_mono_jiterp_tlqueue_add'] = wasmExports['mono_jiterp_tlqueue_add'])(a0, a1);
var _mono_jiterp_tlqueue_clear = Module['_mono_jiterp_tlqueue_clear'] = (a0) => (_mono_jiterp_tlqueue_clear = Module['_mono_jiterp_tlqueue_clear'] = wasmExports['mono_jiterp_tlqueue_clear'])(a0);
var _mono_interp_pgo_load_table = Module['_mono_interp_pgo_load_table'] = (a0, a1) => (_mono_interp_pgo_load_table = Module['_mono_interp_pgo_load_table'] = wasmExports['mono_interp_pgo_load_table'])(a0, a1);
var _mono_interp_pgo_save_table = Module['_mono_interp_pgo_save_table'] = (a0, a1) => (_mono_interp_pgo_save_table = Module['_mono_interp_pgo_save_table'] = wasmExports['mono_interp_pgo_save_table'])(a0, a1);
var _mono_llvm_cpp_catch_exception = Module['_mono_llvm_cpp_catch_exception'] = (a0, a1, a2) => (_mono_llvm_cpp_catch_exception = Module['_mono_llvm_cpp_catch_exception'] = wasmExports['mono_llvm_cpp_catch_exception'])(a0, a1, a2);
var _mono_jiterp_begin_catch = Module['_mono_jiterp_begin_catch'] = (a0) => (_mono_jiterp_begin_catch = Module['_mono_jiterp_begin_catch'] = wasmExports['mono_jiterp_begin_catch'])(a0);
var _mono_jiterp_end_catch = Module['_mono_jiterp_end_catch'] = () => (_mono_jiterp_end_catch = Module['_mono_jiterp_end_catch'] = wasmExports['mono_jiterp_end_catch'])();
var _posix_memalign = Module['_posix_memalign'] = (a0, a1, a2) => (_posix_memalign = Module['_posix_memalign'] = wasmExports['posix_memalign'])(a0, a1, a2);
var _emscripten_main_runtime_thread_id = Module['_emscripten_main_runtime_thread_id'] = () => (_emscripten_main_runtime_thread_id = Module['_emscripten_main_runtime_thread_id'] = wasmExports['emscripten_main_runtime_thread_id'])();
var _mono_wasm_create_deputy_thread = Module['_mono_wasm_create_deputy_thread'] = () => (_mono_wasm_create_deputy_thread = Module['_mono_wasm_create_deputy_thread'] = wasmExports['mono_wasm_create_deputy_thread'])();
var _mono_wasm_create_io_thread = Module['_mono_wasm_create_io_thread'] = () => (_mono_wasm_create_io_thread = Module['_mono_wasm_create_io_thread'] = wasmExports['mono_wasm_create_io_thread'])();
var _mono_wasm_register_ui_thread = Module['_mono_wasm_register_ui_thread'] = () => (_mono_wasm_register_ui_thread = Module['_mono_wasm_register_ui_thread'] = wasmExports['mono_wasm_register_ui_thread'])();
var _mono_wasm_register_io_thread = Module['_mono_wasm_register_io_thread'] = () => (_mono_wasm_register_io_thread = Module['_mono_wasm_register_io_thread'] = wasmExports['mono_wasm_register_io_thread'])();
var _mono_threads_wasm_sync_run_in_target_thread_done = Module['_mono_threads_wasm_sync_run_in_target_thread_done'] = (a0) => (_mono_threads_wasm_sync_run_in_target_thread_done = Module['_mono_threads_wasm_sync_run_in_target_thread_done'] = wasmExports['mono_threads_wasm_sync_run_in_target_thread_done'])(a0);
var _mono_wasm_gc_lock = Module['_mono_wasm_gc_lock'] = () => (_mono_wasm_gc_lock = Module['_mono_wasm_gc_lock'] = wasmExports['mono_wasm_gc_lock'])();
var _mono_wasm_gc_unlock = Module['_mono_wasm_gc_unlock'] = () => (_mono_wasm_gc_unlock = Module['_mono_wasm_gc_unlock'] = wasmExports['mono_wasm_gc_unlock'])();
var _mono_print_method_from_ip = Module['_mono_print_method_from_ip'] = (a0) => (_mono_print_method_from_ip = Module['_mono_print_method_from_ip'] = wasmExports['mono_print_method_from_ip'])(a0);
var __ZdlPv = Module['__ZdlPv'] = (a0) => (__ZdlPv = Module['__ZdlPv'] = wasmExports['_ZdlPv'])(a0);
var _mono_wasm_load_icu_data = Module['_mono_wasm_load_icu_data'] = (a0) => (_mono_wasm_load_icu_data = Module['_mono_wasm_load_icu_data'] = wasmExports['mono_wasm_load_icu_data'])(a0);
var _malloc_usable_size = Module['_malloc_usable_size'] = (a0) => (_malloc_usable_size = Module['_malloc_usable_size'] = wasmExports['malloc_usable_size'])(a0);
var _ntohs = Module['_ntohs'] = (a0) => (_ntohs = Module['_ntohs'] = wasmExports['ntohs'])(a0);
var _htons = Module['_htons'] = (a0) => (_htons = Module['_htons'] = wasmExports['htons'])(a0);
var _emscripten_builtin_free = Module['_emscripten_builtin_free'] = (a0) => (_emscripten_builtin_free = Module['_emscripten_builtin_free'] = wasmExports['emscripten_builtin_free'])(a0);
var __emscripten_tls_init = Module['__emscripten_tls_init'] = () => (__emscripten_tls_init = Module['__emscripten_tls_init'] = wasmExports['_emscripten_tls_init'])();
var _emscripten_builtin_memalign = (a0, a1) => (_emscripten_builtin_memalign = wasmExports['emscripten_builtin_memalign'])(a0, a1);
var __emscripten_run_callback_on_thread = (a0, a1, a2, a3, a4) => (__emscripten_run_callback_on_thread = wasmExports['_emscripten_run_callback_on_thread'])(a0, a1, a2, a3, a4);
var __emscripten_set_offscreencanvas_size_on_thread = (a0, a1, a2, a3) => (__emscripten_set_offscreencanvas_size_on_thread = wasmExports['_emscripten_set_offscreencanvas_size_on_thread'])(a0, a1, a2, a3);
var _emscripten_builtin_malloc = Module['_emscripten_builtin_malloc'] = (a0) => (_emscripten_builtin_malloc = Module['_emscripten_builtin_malloc'] = wasmExports['emscripten_builtin_malloc'])(a0);
var ___funcs_on_exit = () => (___funcs_on_exit = wasmExports['__funcs_on_exit'])();
var ___libc_calloc = Module['___libc_calloc'] = (a0, a1) => (___libc_calloc = Module['___libc_calloc'] = wasmExports['__libc_calloc'])(a0, a1);
var ___libc_free = Module['___libc_free'] = (a0) => (___libc_free = Module['___libc_free'] = wasmExports['__libc_free'])(a0);
var ___libc_malloc = Module['___libc_malloc'] = (a0) => (___libc_malloc = Module['___libc_malloc'] = wasmExports['__libc_malloc'])(a0);
var __emscripten_thread_init = Module['__emscripten_thread_init'] = (a0, a1, a2, a3, a4, a5) => (__emscripten_thread_init = Module['__emscripten_thread_init'] = wasmExports['_emscripten_thread_init'])(a0, a1, a2, a3, a4, a5);
var __emscripten_thread_crashed = Module['__emscripten_thread_crashed'] = () => (__emscripten_thread_crashed = Module['__emscripten_thread_crashed'] = wasmExports['_emscripten_thread_crashed'])();
var _emscripten_main_thread_process_queued_calls = () => (_emscripten_main_thread_process_queued_calls = wasmExports['emscripten_main_thread_process_queued_calls'])();
var _htonl = (a0) => (_htonl = wasmExports['htonl'])(a0);
var __emscripten_run_on_main_thread_js = (a0, a1, a2, a3, a4) => (__emscripten_run_on_main_thread_js = wasmExports['_emscripten_run_on_main_thread_js'])(a0, a1, a2, a3, a4);
var __emscripten_thread_free_data = (a0) => (__emscripten_thread_free_data = wasmExports['_emscripten_thread_free_data'])(a0);
var __emscripten_thread_exit = Module['__emscripten_thread_exit'] = (a0) => (__emscripten_thread_exit = Module['__emscripten_thread_exit'] = wasmExports['_emscripten_thread_exit'])(a0);
var _sbrk = Module['_sbrk'] = (a0) => (_sbrk = Module['_sbrk'] = wasmExports['sbrk'])(a0);
var __emscripten_check_mailbox = () => (__emscripten_check_mailbox = wasmExports['_emscripten_check_mailbox'])();
var _memalign = Module['_memalign'] = (a0, a1) => (_memalign = Module['_memalign'] = wasmExports['memalign'])(a0, a1);
var __ZdaPv = Module['__ZdaPv'] = (a0) => (__ZdaPv = Module['__ZdaPv'] = wasmExports['_ZdaPv'])(a0);
var __ZdaPvm = Module['__ZdaPvm'] = (a0, a1) => (__ZdaPvm = Module['__ZdaPvm'] = wasmExports['_ZdaPvm'])(a0, a1);
var __ZdlPvm = Module['__ZdlPvm'] = (a0, a1) => (__ZdlPvm = Module['__ZdlPvm'] = wasmExports['_ZdlPvm'])(a0, a1);
var __Znaj = Module['__Znaj'] = (a0) => (__Znaj = Module['__Znaj'] = wasmExports['_Znaj'])(a0);
var __ZnajSt11align_val_t = Module['__ZnajSt11align_val_t'] = (a0, a1) => (__ZnajSt11align_val_t = Module['__ZnajSt11align_val_t'] = wasmExports['_ZnajSt11align_val_t'])(a0, a1);
var __Znwj = Module['__Znwj'] = (a0) => (__Znwj = Module['__Znwj'] = wasmExports['_Znwj'])(a0);
var __ZnwjSt11align_val_t = Module['__ZnwjSt11align_val_t'] = (a0, a1) => (__ZnwjSt11align_val_t = Module['__ZnwjSt11align_val_t'] = wasmExports['_ZnwjSt11align_val_t'])(a0, a1);
var ___libc_realloc = Module['___libc_realloc'] = (a0, a1) => (___libc_realloc = Module['___libc_realloc'] = wasmExports['__libc_realloc'])(a0, a1);
var _malloc_size = Module['_malloc_size'] = (a0) => (_malloc_size = Module['_malloc_size'] = wasmExports['malloc_size'])(a0);
var _reallocf = Module['_reallocf'] = (a0, a1) => (_reallocf = Module['_reallocf'] = wasmExports['reallocf'])(a0, a1);
var ___trap = () => (___trap = wasmExports['__trap'])();
var _emscripten_stack_set_limits = (a0, a1) => (_emscripten_stack_set_limits = wasmExports['emscripten_stack_set_limits'])(a0, a1);
var stackSave = Module['stackSave'] = () => (stackSave = Module['stackSave'] = wasmExports['stackSave'])();
var stackRestore = Module['stackRestore'] = (a0) => (stackRestore = Module['stackRestore'] = wasmExports['stackRestore'])(a0);
var stackAlloc = Module['stackAlloc'] = (a0) => (stackAlloc = Module['stackAlloc'] = wasmExports['stackAlloc'])(a0);
var _SDL3_renamed___em_lib_deps_sdlrunapp = Module['_SDL3_renamed___em_lib_deps_sdlrunapp'] = 17411156;
var _SDL3_renamed___em_lib_deps_sdlsysurl = Module['_SDL3_renamed___em_lib_deps_sdlsysurl'] = 17411182;
var _SDL3_renamed___em_lib_deps_sdlaudio = Module['_SDL3_renamed___em_lib_deps_sdlaudio'] = 17411196;
var _SDL3_renamed___em_lib_deps_dragndrop = Module['_SDL3_renamed___em_lib_deps_dragndrop'] = 17411229;
var _SDL3_renamed___em_lib_deps_sdlmouse = Module['_SDL3_renamed___em_lib_deps_sdlmouse'] = 17411249;
var ___start_em_js = Module['___start_em_js'] = 17411277;
var ___stop_em_js = Module['___stop_em_js'] = 17412369;

// === Auto-generated postamble setup entry stuff ===

Module['addRunDependency'] = addRunDependency;
Module['removeRunDependency'] = removeRunDependency;
Module['FS_createPath'] = FS.createPath;
Module['FS_createLazyFile'] = FS.createLazyFile;
Module['FS_createDevice'] = FS.createDevice;
Module['out'] = out;
Module['err'] = err;
Module['abort'] = abort;
Module['wasmMemory'] = wasmMemory;
Module['wasmExports'] = wasmExports;
Module['keepRuntimeAlive'] = keepRuntimeAlive;
Module['runtimeKeepalivePush'] = runtimeKeepalivePush;
Module['runtimeKeepalivePop'] = runtimeKeepalivePop;
Module['maybeExit'] = maybeExit;
Module['ccall'] = ccall;
Module['cwrap'] = cwrap;
Module['addFunction'] = addFunction;
Module['setValue'] = setValue;
Module['getValue'] = getValue;
Module['UTF8ArrayToString'] = UTF8ArrayToString;
Module['UTF8ToString'] = UTF8ToString;
Module['stringToUTF8Array'] = stringToUTF8Array;
Module['lengthBytesUTF8'] = lengthBytesUTF8;
Module['ExitStatus'] = ExitStatus;
Module['safeSetTimeout'] = safeSetTimeout;
Module['FS_createPreloadedFile'] = FS.createPreloadedFile;
Module['FS'] = FS;
Module['FS_createDataFile'] = FS.createDataFile;
Module['FS_unlink'] = FS.unlink;
Module['PThread'] = PThread;


var calledRun;

dependenciesFulfilled = function runCaller() {
  // If run has never been called, and we should call run (INVOKE_RUN is true, and Module.noInitialRun is not false)
  if (!calledRun) run();
  if (!calledRun) dependenciesFulfilled = runCaller; // try this again later, after new deps are fulfilled
};

function run() {

  if (runDependencies > 0) {
    return;
  }

  if (ENVIRONMENT_IS_PTHREAD) {
    // The promise resolve function typically gets called as part of the execution
    // of `doRun` below. The workers/pthreads don't execute `doRun` so the
    // creation promise can be resolved, marking the pthread-Module as initialized.
    readyPromiseResolve(Module);
    initRuntime();
    startWorker(Module);
    return;
  }

  preRun();

  // a preRun added a dependency, run will be called later
  if (runDependencies > 0) {
    return;
  }

  function doRun() {
    // run may have just been called through dependencies being fulfilled just in this very frame,
    // or while the async setStatus time below was happening
    if (calledRun) return;
    calledRun = true;
    Module['calledRun'] = true;

    if (ABORT) return;

    initRuntime();

    readyPromiseResolve(Module);
    if (Module['onRuntimeInitialized']) Module['onRuntimeInitialized']();

    postRun();
  }

  if (Module['setStatus']) {
    Module['setStatus']('Running...');
    setTimeout(function() {
      setTimeout(function() {
        Module['setStatus']('');
      }, 1);
      doRun();
    }, 1);
  } else
  {
    doRun();
  }
}

if (Module['preInit']) {
  if (typeof Module['preInit'] == 'function') Module['preInit'] = [Module['preInit']];
  while (Module['preInit'].length > 0) {
    Module['preInit'].pop()();
  }
}

run();




  return moduleArg.ready
}
);
})();
export default createDotnetRuntime;
var fetch = fetch || undefined; var require = require || undefined; var __dirname = __dirname || ''; var _nativeModuleLoaded = false;
