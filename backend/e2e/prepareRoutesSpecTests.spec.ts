import * as bcrypt from 'bcryptjs';
import * as chai from 'chai';
import chaiHttp = require('chai-http');
import app from '../src/App';
import { Configuration } from '../src/config';
import { UsersDalSingleton } from '../src/data-layer/usersDal';
import { Login, Minion } from '../src/models/sharedInterfaces';
import { User } from '../src/models/sharedInterfaces';

/**
 * Perpare chai session agent.
 */
chai.use(chaiHttp);
const userAgent = chai.request.agent(app);
const adminAgent = chai.request.agent(app);

/**
 * Reset data, for testing all system flow.
 */
const unHashedUserPassword = '2574653478565761341114';
const signInUser: User = {
    email: 'user@casa.net',
    displayName: 'user account',
    ignoreTfa: true,
    password: bcrypt.hashSync(unHashedUserPassword, Configuration.keysHandling.bcryptSaltRounds),
    sessionTimeOutMS: 123454321100000,
    scope: 'userAuth',
};

const unHashedAdminPassword = 'fdsfdjhhg743278956djkb';
const signInAdmin: User = {
    email: 'admin@casa.net',
    displayName: 'admin account',
    ignoreTfa: true,
    password: bcrypt.hashSync(unHashedAdminPassword, Configuration.keysHandling.bcryptSaltRounds),
    sessionTimeOutMS: 123454321100000,
    scope: 'adminAuth',
};

/**
 * Hold keys in struct for export by ref and not by val.
 */
const sessionKey: { userSessionKey?: string, adminSessionKey?: string } = {};

/**
 * Create user to login to it, and then all system specs can use it in as routing cert.
 */
UsersDalSingleton.createUser(signInUser)
    .then(() => {

        /**
         * The valied login schema model.
         */
        const loginSchema: Login = {
            email: signInUser.email,
            password: unHashedUserPassword,
        };

        /**
         * Login to system then the load session agent can be used
         * in other spec's to check thire tests.
         */
        userAgent.post('/API/auth/login')
            .send(loginSchema)
            .end((err, res) => {

                if (err || res.statusType !== 2) {
                    console.error('Perpare user agent fail, all API tests specs that need user certs will fail too.');
                } else {
                    const cookie: string = res['headers']['set-cookie'][0] as string;
                    sessionKey.userSessionKey = cookie.split(';')[0].split('=')[1];
                }
            });

        /**
         * Create admin user.
         */
        UsersDalSingleton.createUser(signInAdmin)
            .then(() => {

                /**
                 * The valied login schema model.
                 */
                const loginAdminSchema: Login = {
                    email: signInAdmin.email,
                    password: unHashedAdminPassword,
                };

                /**
                 * Same as user agent just in admin certs.
                 */
                adminAgent.post('/API/auth/login')
                    .send(loginAdminSchema)
                    .end((err, res) => {

                        if (err || res.statusType !== 2) {
                            console.error('Perpare admin agent fail, all API tests specs that need admin certs will fail too.');
                        } else {
                            const cookie: string = res['headers']['set-cookie'][0] as string;
                            sessionKey.adminSessionKey = cookie.split(';')[0].split('=')[1];
                        }
                    });

            });
    });

/**
 * Check if user want test the long time tests sucj as scanning real network etc.
 */
const testLongSpecsSelection = process.env.TEST_LONG_SPECS !== 'false';
if (testLongSpecsSelection) {
    console.log(`Testing all specs, to avoid long time duration test set TEST_LONG_SPECS env var to 'false'`);
} else {
    console.log(`Avoiding long time duration specs, to change it set TEST_LONG_SPECS env var to 'true'`);
}

/**
 * API
 */

/**
 * A valid user password.
 */
export const validUserPlainPassword = unHashedUserPassword;

/**
 * A valid user password.
 */
export const validAdminPlainPassword = unHashedAdminPassword;

/**
 * A valid user object.
 */
export const validSystemUser = signInUser;

/**
 * A valid user (with admin premission) object.
 */
export const validSystemAdmin = signInAdmin;

/**
 * A valid sessions cookie session key.
 */
export const validSession = sessionKey;

/**
 * An express test agent with valid cookie as user.
 */
export const validUserAgent = userAgent;

/**
 * An express test agent with valid cookie as admin.
 */
export const validAdminAgent = adminAgent;

/**
 * Mark if user want to test all tests, even the long time tests.
 */
export const testLongSpecs: boolean = testLongSpecsSelection;
