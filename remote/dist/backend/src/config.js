"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv = require("dotenv");
const fs_1 = require("fs");
const fse = require("fs-extra");
const randomstring = require("randomstring");
const logger_1 = require("./utilities/logger");
// load environment variable from .env file
if (fs_1.existsSync('.env')) {
    dotenv.config();
}
/**
 * Read process env vars
 */
const rawHttpPort = process.env.HTTP_PORT;
const rawHttpsPort = process.env.HTTPS_PORT;
const rawUserHttps = process.env.USE_HTTPS;
const rawNodeEnv = process.env.NODE_ENV;
const rawTfaSmtpServer = process.env.TFA_SMTP_SERVER;
const rawTfaUserName = process.env.TFA_USER_NAME;
const rawTfaUserKey = process.env.TFA_USER_KEY;
const rawSaltKeys = process.env.SALT_KEYS;
const rawSubnetToScan = process.env.SUBNET_TO_SCAN;
/**
 * Read casanet configuration file.
 */
let configuration;
try {
    configuration = fse.readJSONSync('casanet.json');
}
catch (error) {
    logger_1.logger.error('Fail to read casanet.json configuration file. exit...');
    process.exit();
}
/**
 * Set running mode.
 */
switch (rawNodeEnv) {
    case 'test':
        configuration.runningMode = 'test';
        break;
    case 'debug':
        configuration.runningMode = 'debug';
        break;
    case 'prod':
        configuration.runningMode = 'prod';
        break;
    default:
        configuration.runningMode = 'prod';
        break;
}
logger_1.logger.info(`casa-net app running in -${configuration.runningMode}- mode (use environments vars "NODE_ENV" to change it)`);
if (!rawHttpPort) {
    logger_1.logger.warn('There is no HTTP_PORT env var, using default port ' + configuration.http.httpPort);
}
else {
    configuration.http.httpPort = parseInt(rawHttpPort, 10);
}
if (!rawHttpsPort) {
    logger_1.logger.warn('There is no HTTP_PORTS env var, using default port ' + configuration.http.httpsPort);
}
else {
    configuration.http.httpsPort = parseInt(rawHttpsPort, 10);
}
if (!rawUserHttps) {
    logger_1.logger.warn('There is no USE_HTTPS env var, using default, ' + configuration.http.useHttps);
}
else {
    configuration.http.useHttps = rawUserHttps.toLowerCase() !== 'false';
}
if (rawTfaSmtpServer && rawTfaUserName && rawTfaUserKey) {
    configuration.twoStepsVerification = {
        TwoStepEnabled: true,
        smtpServer: rawTfaSmtpServer,
        userKey: rawTfaUserKey,
        userName: rawTfaUserName,
    };
}
else {
    logger_1.logger.warn('The 2-step verification in disabled, to enable it set TFA_SMTP_SERVER TFA_USER_NAME TFA_USER_KEY env var correct value.');
    configuration.twoStepsVerification = {
        TwoStepEnabled: false,
        smtpServer: '',
        userKey: '',
        userName: '',
    };
}
if (!rawSaltKeys) {
    logger_1.logger.warn('There is no SALT_KEYS env var, generating random');
}
configuration.keysHandling = {
    saltHash: rawSaltKeys || randomstring.generate(64),
    bcryptSaltRounds: 12,
};
if (!rawSubnetToScan) {
    logger_1.logger.warn('There is no SUBNET_TO_SCAN env var, the default subnet is current machine ip subnet.');
}
configuration.scanSubnet = rawSubnetToScan;
/** System configuration */
exports.Configuration = configuration;
//# sourceMappingURL=config.js.map