const path = require('path');
const map = require('p-map');
const fs = require('fs');
const cp = require('child_process');

const Reporter = require('./../Reporter');
const logger = require('./../logger')('compare');
const storeFailedDiffStub = require('./store-failed-diff-stub.js');

const ASYNC_COMPARE_LIMIT = 20;

async function comparePair (pair, report, config, compareConfig) {
  const Test = report.addTest(pair);

  const referencePath = pair.reference ? path.resolve(config.projectPath, pair.reference) : '';
  const testPath = pair.test ? path.resolve(config.projectPath, pair.test) : '';
  const forceDiffPng = !!config.args.config.forceDiffPng;

  // TEST RUN ERROR/EXCEPTION
  if (!referencePath || !testPath) {
    const MSG = `${pair.msg}: ${pair.error}. See scenario – ${pair.scenario.label} (${pair.viewport.label})`;
    Test.status = 'fail';
    logger.error(MSG);
    pair.error = MSG;
    return pair;
  }

  // REFERENCE NOT FOUND ERROR
  if (!fs.existsSync(referencePath)) {
    // save a failed image stub
    storeFailedDiffStub(testPath, forceDiffPng);

    Test.status = 'fail';
    logger.error('Reference image not found ' + pair.fileName);
    pair.error = 'Reference file not found ' + referencePath;
    return pair;
  }

  if (!fs.existsSync(testPath)) {
    Test.status = 'fail';
    logger.error('Test image not found ' + pair.fileName);
    pair.error = 'Test file not found ' + testPath;
    return pair;
  }

  if (pair.expect) {
    const scenarioCount = compareConfig.testPairs.filter(p => p.label === pair.label && p.viewportLabel === pair.viewportLabel).length;
    if (scenarioCount !== pair.expect) {
      Test.status = 'fail';
      const error = `Expect ${pair.expect} images for scenario "${pair.label} (${pair.viewportLabel})", but actually ${scenarioCount} images be found.`;
      logger.error(error);
      pair.error = error;
      return pair;
    }
  }

  const resembleOutputSettings = config.resembleOutputOptions;
  try {
    return await compareImages(referencePath, testPath, pair, resembleOutputSettings, Test, forceDiffPng);
  } catch (e) {
    const message = typeof e === 'string'? e: e instanceof Error? e.message: 'unknown error';
    logger.error(message);
    pair.error = message
  }
}

function compareImages (referencePath, testPath, pair, resembleOutputSettings, Test, forceDiffPng = false) {
  return new Promise(function (resolve, reject) {
    const worker = cp.fork(require.resolve('./compare'));
    worker.send({
      referencePath,
      testPath,
      resembleOutputSettings,
      pair,
      forceDiffPng
    });

    worker.on('message', function (data) {
      clearTimeout(timeoutHandle);
      worker.kill();
      Test.status = data.status;
      pair.diff = data.diff;

      if (data.status === 'fail') {
        pair.diffImage = data.diffImage;
        logger.error('ERROR { requireSameDimensions: ' + (data.requireSameDimensions ? 'true' : 'false') + ', size: ' + (data.isSameDimensions ? 'ok' : 'isDifferent') + ', content: ' + data.diff.misMatchPercentage + '%, threshold: ' + pair.misMatchThreshold + '% }: ' + pair.label + ' ' + pair.fileName);
      } else {
        logger.success('OK: ' + pair.label + ' ' + pair.fileName);
      }

      resolve(data);
    });

    var timeoutHandle = setTimeout(() => {
      worker.kill();
      reject(new Error(`child process hangs/killed accidently, reference path is [${referencePath}]`))
    }, 60000);
  });
}

module.exports = function (config) {
  const compareConfig = require(config.tempCompareConfigFileName).compareConfig;

  const report = new Reporter(config.ciReport.testSuiteName);
  const asyncCompareLimit = config.asyncCompareLimit || ASYNC_COMPARE_LIMIT;
  report.id = config.id;

  return map(compareConfig.testPairs, pair => comparePair(pair, report, config, compareConfig), { concurrency: asyncCompareLimit })
    .then(
      () => report,
      e => logger.error('The comparison failed with error: ' + e)
    );
};
