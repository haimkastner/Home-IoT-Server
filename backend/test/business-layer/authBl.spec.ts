import * as chai from 'chai';
import { assert, expect } from 'chai';
import * as cryptoJs from 'crypto-js';
import * as express from 'express';
import { AuthBl } from '../../src/business-layer/authBl';
import { SessionsBl } from '../../src/business-layer/sessionsBl';
import { UsersBl } from '../../src/business-layer/usersBl';
import { Configuration } from '../../src/config';
import { SessionsDal } from '../../src/data-layer/sessionsDal';
import { UsersDal } from '../../src/data-layer/usersDal';
import { ErrorResponse, User } from '../../src/models/sharedInterfaces';
import { SessionsDalMock } from '../data-layer/sessionsDal.mock.spec';
import { UsersDalMock } from '../data-layer/usersDal.mock.spec';

const usersDalMock = new UsersDalMock();
const sessionsDalMock = new SessionsDalMock();
const authBlMock = new AuthBl(new SessionsBl(sessionsDalMock as unknown as SessionsDal),
    new UsersBl(usersDalMock as unknown as UsersDal));

const GENERIC_ERROR_RESPONSE: ErrorResponse = {
    responseCode: 2403,
    message: 'username or password is incorrect',
};

describe('Authentication BL tests', () => {

    describe('Login to system', () => {
        it('it should login succsessfully', async () => {

            const expressResponseMock: unknown = {
                cookie: (sessionName: string, sessionKey: string, options: {}) => {
                    expect(sessionName).to.equal('session');
                    expect(sessionKey).to.be.a('string').length.above(60);
                    expect(options).to.be.deep.equal({
                        sameSite: true,
                        httpOnly: true, // minimize risk of XSS attacks by restricting the client from reading the cookie
                        secure: Configuration.http.useHttps, // only send cookie over https
                        maxAge: usersDalMock.mockUsers[0].sessionTimeOutMS,
                    });
                },
            };
            const pass = usersDalMock.mockUsers[0].password;
            const passHash = cryptoJs.SHA256(pass).toString();
            usersDalMock.mockUsers[0].password = passHash;
            await authBlMock.login(expressResponseMock as express.Response, {
                email: usersDalMock.mockUsers[0].email,
                password: pass,
            });

        });

        it('it should denied login', async () => {

            const expressResponseMock: unknown = {
                cookie: (sessionName: string, sessionKey: string, options: {}) => {
                    throw new Error('login request should be forbidden, the user name not exist');
                },
            };
            const error = await authBlMock.login(expressResponseMock as express.Response, {
                email: (usersDalMock.mockUsers[0].email + 'ttt'),
                password: usersDalMock.mockUsers[0].password,
            });

            expect(error).to.deep.equal(GENERIC_ERROR_RESPONSE);
        });

        it('it should denied login', async () => {

            const expressResponseMock: unknown = {
                cookie: (sessionName: string, sessionKey: string, options: {}) => {
                    throw new Error('login request should be forbidden, the user passwrod incorrect');
                },
            };
            const error = await authBlMock.login(expressResponseMock as express.Response, {
                email: (usersDalMock.mockUsers[0].email),
                password: usersDalMock.mockUsers[0].password + 'ttt',
            });

            expect(error).to.deep.equal(GENERIC_ERROR_RESPONSE);
        });

        it('it should denied login ta', async () => {

            const expressResponseMock: unknown = {
                cookie: (sessionName: string, sessionKey: string, options: {}) => {
                    throw new Error('login request should be forbidden, the user MFA code never required');
                },
            };
            const error = await authBlMock.loginTfa(expressResponseMock as express.Response, {
                email: (usersDalMock.mockUsers[0].email),
                password: usersDalMock.mockUsers[0].password,
            });

            expect(error).to.deep.equal(GENERIC_ERROR_RESPONSE);
        });
    });
});
