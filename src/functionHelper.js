'use strict';

const { fork, spawn } = require('child_process');
const { join, resolve } = require('path');
const objectFromEntries = require('object.fromentries');
const trimNewlines = require('trim-newlines');
const debugLog = require('./debugLog.js');
const { createUniqueId } = require('./utils/index.js');

objectFromEntries.shim();

const { parse, stringify } = JSON;
const { entries, fromEntries, keys, values } = Object;

const handlerCache = {};
const messageCallbacks = {};

function runServerlessProxy(funOptions, options) {
  return (event, context) => {
    const args = ['invoke', 'local', '-f', funOptions.functionName];
    const stage = options.s || options.stage;

    if (stage) args.push('-s', stage);

    // Use path to binary if provided, otherwise assume globally-installed
    const binPath = options.b || options.binPath;
    const cmd = binPath || 'sls';

    const process = spawn(cmd, args, {
      cwd: funOptions.servicePath,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    process.stdin.write(`${stringify(event)}\n`);
    process.stdin.end();

    let results = '';
    let hasDetectedJson = false;

    process.stdout.on('data', (data) => {
      let str = data.toString('utf8');

      if (hasDetectedJson) {
        // Assumes that all data after matching the start of the
        // JSON result is the rest of the context result.
        results += trimNewlines(str);
      } else {
        // Search for the start of the JSON result
        // https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-output-format
        const match = /{[\r\n]?\s*"isBase64Encoded"|{[\r\n]?\s*"statusCode"|{[\r\n]?\s*"headers"|{[\r\n]?\s*"body"|{[\r\n]?\s*"principalId"/.exec(
          str,
        );

        if (match && match.index > -1) {
          // The JSON result was in this chunk so slice it out
          hasDetectedJson = true;
          results += trimNewlines(str.slice(match.index));
          str = str.slice(0, match.index);
        }

        if (str.length > 0) {
          // The data does not look like JSON and we have not
          // detected the start of JSON, so write the
          // output to the console instead.
          console.log('Proxy Handler could not detect JSON:', str);
        }
      }
    });

    process.stderr.on('data', (data) => {
      context.fail(data);
    });

    process.on('close', (code) => {
      if (code.toString() === '0') {
        try {
          context.succeed(parse(results));
        } catch (ex) {
          context.fail(results);
        }
      } else {
        context.succeed(code, results);
      }
    });
  };
}

exports.getFunctionOptions = function getFunctionOptions(
  functionObj,
  functionName,
  servicePath,
  serviceRuntime,
) {
  // Split handler into method name and path i.e. handler.run
  // Support nested paths i.e. ./src/somefolder/.handlers/handler.run
  const lastIndexOfDelimiter = functionObj.handler.lastIndexOf('.');
  const handlerPath = functionObj.handler.substr(0, lastIndexOfDelimiter);
  const handlerName = functionObj.handler.substr(lastIndexOfDelimiter + 1);

  return {
    functionName,
    handlerName, // i.e. run
    handlerPath: join(servicePath, handlerPath),
    memorySize: functionObj.memorySize,
    runtime: functionObj.runtime || serviceRuntime,
    timeout: (functionObj.timeout || 30) * 1000,
  };
};

exports.createExternalHandler = function createExternalHandler(
  funOptions,
  options,
) {
  let handlerContext = handlerCache[funOptions.handlerPath];

  function handleFatal(error) {
    debugLog(`External handler received fatal error ${stringify(error)}`);
    handlerContext.inflight.forEach((id) => {
      messageCallbacks[id](error);
    });
    handlerContext.inflight.clear();
    delete handlerCache[funOptions.handlerPath];
  }

  if (!handlerContext) {
    debugLog(`Loading external handler... (${funOptions.handlerPath})`);

    const helperPath = resolve(__dirname, 'ipcHelper.js');

    const env = fromEntries(
      entries(process.env).filter(
        ([, value]) => value !== undefined && value !== 'undefined',
      ),
    );

    const ipcProcess = fork(helperPath, [funOptions.handlerPath], {
      env,
      stdio: [0, 1, 2, 'ipc'],
    });

    handlerContext = {
      inflight: new Set(),
      process: ipcProcess,
    };

    if (options.skipCacheInvalidation) {
      handlerCache[funOptions.handlerPath] = handlerContext;
    }

    ipcProcess.on('message', (message) => {
      debugLog(`External handler received message ${stringify(message)}`);

      if (message.id && messageCallbacks[message.id]) {
        messageCallbacks[message.id](message.error, message.ret);
        handlerContext.inflight.delete(message.id);
        delete messageCallbacks[message.id];
      } else if (message.error) {
        // Handler died!
        handleFatal(message.error);
      }

      if (!options.skipCacheInvalidation) {
        handlerContext.process.kill();
        delete handlerCache[funOptions.handlerPath];
      }
    });

    ipcProcess.on('error', (error) => {
      handleFatal(error);
    });

    ipcProcess.on('exit', (code) => {
      handleFatal(`Handler process exited with code ${code}`);
    });
  } else {
    debugLog(`Using existing external handler for ${funOptions.handlerPath}`);
  }

  return (event, context, done) => {
    const id = createUniqueId();
    messageCallbacks[id] = done;
    handlerContext.inflight.add(id);

    handlerContext.process.send({
      ...funOptions,
      context,
      event,
      id,
    });
  };
};

// function handler used to simulate Lambda functions
exports.createHandler = function createHandler(funOptions, options) {
  if (options.useSeparateProcesses) {
    return exports.createExternalHandler(funOptions, options);
  }

  if (!options.skipCacheInvalidation) {
    debugLog('Invalidating cache...');

    keys(require.cache).forEach((key) => {
      // Require cache invalidation, brutal and fragile.
      // Might cause errors, if so please submit an issue.
      if (!key.match(options.cacheInvalidationRegex || /node_modules/)) {
        delete require.cache[key];
      }
    });

    const currentFilePath = __filename;

    if (
      require.cache[currentFilePath] &&
      require.cache[currentFilePath].children
    ) {
      const nextChildren = [];

      require.cache[currentFilePath].children.forEach((moduleCache) => {
        if (
          moduleCache.filename.match(
            options.cacheInvalidationRegex || /node_modules/,
          )
        ) {
          nextChildren.push(moduleCache);
        }
      });

      require.cache[currentFilePath].children = nextChildren;
    }
  }

  debugLog(`Loading handler... (${funOptions.handlerPath})`);

  const handler = funOptions.runtime.startsWith('nodejs')
    ? require(funOptions.handlerPath)[funOptions.handlerName] // eslint-disable-line
    : runServerlessProxy(funOptions, options);

  if (typeof handler !== 'function') {
    throw new Error(
      `Serverless-offline: handler for '${funOptions.functionName}' is not a function`,
    );
  }

  return handler;
};

exports.functionCacheCleanup = function functionCacheCleanup() {
  values(handlerCache).forEach((value) => {
    value.process.kill();
  });
};
