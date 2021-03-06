/**
 * Important thing is that no event is fired until `end` happens.
 * This is because of `retry` option which appeared in 0.2 version
 * 
 * In fact `retry` changes everything:
 * in 0.1 mocha-parallel-tests could emit events as soon as they appear.
 * The only limitation is some kind of `currently being executed file`, i.e.
 * we can't emit events in the middle of another test file being processed
 *
 * In 0.2 `retry` options appears and error can happen after 2 successful tests in one suite.
 * Also by this time other files could've finished executing so it's safe to show their events
 * So `mocha-parallel-tests` waits for `end` event and emits accumulated events then
 */
'use strict';

import path from 'path';
import debug from 'debug';
import MochaBaseReporter from 'mocha/lib/reporters/base';
import {getInstance as getRunnerInstance} from './runner';
import {stdStreamsEmitter} from './watcher';

const RUNNER_EVENTS = [
    'suite',
    'suite end',
    'test',
    'pending',
    'pass',
    'test end',
    'fail',
    'failRetry'
];

const debugLog = debug('mocha-parallel-tests:reporter');
let reporterInstance;
let testsFinished = 0;
let failsOccured = 0;

// save original standard streams methods
// because lib/watcher.js overwites them
const originalWrites = {
    stderr: process.stderr.write.bind(process.stderr),
    stdout: process.stdout.write.bind(process.stdout)
};

// some console.logs are fired before instance of Reporter is created
// so it's better to have some kind of hash table with intercepted messages
const stdMessagesMap = new Map;
stdStreamsEmitter.on('message', function (data) {
    if (!stdMessagesMap.has(data.file)) {
        stdMessagesMap.set(data.file, []);
    }

    const fileMessages = stdMessagesMap.get(data.file);
    fileMessages.push({
        streamName: data.streamName,
        message: data.message,
        timestamp: Date.now()
    });

    stdMessagesMap.set(data.file, fileMessages);
});

class AbstractReporter extends MochaBaseReporter {
    constructor(runner, options = {}) {
        super(runner);

        this._runnerWrapped = getRunnerInstance();
        this._runner = runner;
        this._options = options;
        this._eventsNotEmited = []; // array events

        // create "real" reporter to output our runner events
        this._setReporterOnce();

        this._detectFile();
        this._listenToRunnerEvents();

        // start queue
        this._runnerWrapped.start();
    }

    _detectFile() {
        if (this._runner.suite.suites.length) {
            this._testFile = this._runner.suite.suites[0].file;
            this._relativeFilePath = path.relative(__filename, this._testFile);

            // if fail happens and another try is available
            // clear intercepted messages
            stdStreamsEmitter.on('fail', file => stdMessagesMap.delete(file));
        }
    }

    _setReporterOnce() {
        if (reporterInstance) {
            return;
        }

        this._options.reporterName = this._options.reporterName || 'spec';
        
        const reporterTryPaths = [
            `mocha/lib/reporters/${this._options.reporterName}`,
            this._options.reporterName,
            path.resolve(process.cwd(), this._options.reporterName)
        ];

        let UserReporter;
        for (let reporterPath of reporterTryPaths) {
            try {
                UserReporter = require(reporterPath);
                break;
            } catch (evt) {
                // pass
            }
        }

        if (!UserReporter) {
            throw new Error(`Invalid reporter "${this._options.reporterName}"`);
        }

        reporterInstance = new UserReporter(this._runnerWrapped, this._options);
    }

    _storeEventData({eventType, args}) {
        debugLog(`${eventType} event fired (${this._relativeFilePath})`);

        this._eventsNotEmited.push({
            type: eventType,
            data: args,
            timestamp: Date.now()
        });
    }

    _listenToRunnerEvents() {
        for (let eventType of RUNNER_EVENTS) {
            this._runner.on(eventType, (...args) => {
                this._storeEventData({eventType, args});

                if (eventType === 'fail') {
                    failsOccured++;
                } else if (eventType === 'failRetry') {
                    failsOccured--;
                    this._runnerWrapped.emit(eventType, ...args);
                }
            });
        }

        this._runner.on('end', () => {
            debugLog(`end event fired (${this._relativeFilePath})`);

            // combine stored events and intercepted messages
            const allEvents = [];

            // first append all runner events
            this._eventsNotEmited.forEach((eventData, index) => {
                allEvents.push({
                    type: 'runnerEvent',
                    payload: {
                        type: eventData.type,
                        data: eventData.data
                    },
                    meta: {
                        index,
                        timestamp: eventData.timestamp
                    }
                });
            });

            // then append all standard streams messages
            (stdMessagesMap.get(this._testFile) || []).forEach((data, index) => {
                allEvents.push({
                    type: 'stdStreamMessage',
                    payload: {
                        streamName: data.streamName,
                        message: data.message
                    },
                    meta: {
                        index,
                        timestamp: data.timestamp
                    }
                });
            });

            // sort all events by timestamp and re-emit
            allEvents.sort((a, b) => {
                const timestampDiff = a.meta.timestamp - b.meta.timestamp;

                if (timestampDiff) {
                    return timestampDiff;
                }

                const aEventWeight = (a.type === 'runnerEvent') ? 1 : 0;
                const bEventWeight = (b.type === 'runnerEvent') ? 1 : 0;
                const weightDiff = aEventWeight - bEventWeight;

                if (weightDiff) {
                    return weightDiff;
                }

                return a.meta.index - b.meta.index;
            }).forEach(eventData => {
                if (eventData.type === 'runnerEvent') {
                    this._runnerWrapped.emit(eventData.payload.type, ...eventData.payload.data);
                } else if (eventData.type === 'stdStreamMessage') {
                    originalWrites[eventData.payload.streamName](eventData.payload.message);
                }
            });

            testsFinished++;

            if (testsFinished === this._options.testsLength) {
                debugLog(`This is the end: ${testsFinished}/${this._options.testsLength}`);
                this._runnerWrapped.end(failsOccured);
            } else {
                debugLog(`This is still not the end: ${testsFinished}/${this._options.testsLength}`);
            }
        });
    }
}

export default AbstractReporter;
