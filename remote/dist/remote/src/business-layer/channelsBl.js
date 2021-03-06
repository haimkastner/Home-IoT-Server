"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cryptoJs = require("crypto-js");
const momoent = require("moment");
const moment = require("moment");
const randomstring = require("randomstring");
const rxjs_1 = require("rxjs");
const config_1 = require("../../../backend/src/config");
const logger_1 = require("../../../backend/src/utilities/logger");
const mailSender_1 = require("../../../backend/src/utilities/mailSender");
const forwardUserSessionsBl_1 = require("./forwardUserSessionsBl");
const localServersBl_1 = require("./localServersBl");
const localServersSessionsBl_1 = require("./localServersSessionsBl");
/**
 * Manage all local servers ws I/O messages.
 * The main goal is to allow used ws protocol as req/res architecture.
 * So when user send HTTP request it will forward to local server via ws and
 * returns response, evan thet ws is messages architecture based.
 */
class ChannelsBl {
    /**
     * Init channels bl. using dependecy injection pattern to allow units testings.
     * @param localServersBl local servers bl injection.
     * @param localServersSessionsBl local server bl sessions injection.
     */
    constructor(localServersBl, localServersSessionsBl, forwardUsersSessionsBl) {
        this.localServersBl = localServersBl;
        this.localServersSessionsBl = localServersSessionsBl;
        this.forwardUsersSessionsBl = forwardUsersSessionsBl;
        /**
         * Timeout for any http request.
         * (it long time bacuse of scaning network request that takes a while.)
         */
        this.httpRequestTimeout = moment.duration(60, 'seconds');
        /** Map all local servers ws channel by local server mac address */
        this.localChannelsMap = {};
        /**
         * Hold each request promise reject/resolve methods.
         * until message will arrive from local server with response for current request.
         */
        this.sentHttpRequestsMap = {};
        /**
         * Register generated code map to account with creation timestamp.
         */
        this.forwardUserReqAuth = {};
        /** Feed of local servers feeds. */
        this.localServersFeed = new rxjs_1.BehaviorSubject(undefined);
        /** Invoke requests timeout activation. */
        this.setTimeoutRequestsActivation();
    }
    /**
     * Timeout of each request activation.
     * Used to clean up and send timeout response to requestes
     * that local server not answer to them.
     */
    setTimeoutRequestsActivation() {
        setInterval(() => {
            const now = new Date();
            // Iterate all API requests.
            for (const [key, value] of Object.entries(this.sentHttpRequestsMap)) {
                if (now.getTime() - value.timeStamped.getTime() > this.httpRequestTimeout.asMilliseconds()) {
                    delete this.sentHttpRequestsMap[key];
                    value.forwardPromise.resolve({
                        requestId: key,
                        httpBody: { responseCode: 8503, message: 'local server timeout' },
                        httpSession: undefined,
                        httpStatus: 501,
                    });
                }
            }
        }, moment.duration(10, 'seconds').asMilliseconds());
    }
    /**
     * Handle init request from local server, check if cert is OK.
     * @param wsChannel ws client object.
     * @param certAuth local server auth cert data
     */
    async handleInitializationRequest(wsChannel, certAuth) {
        try {
            /** Get the local server based on cert mac address. */
            const localServer = await this.localServersBl.getlocalServersByMac(certAuth.macAddress);
            /** Get local server session based on local server id.  */
            const localServerSession = await this.localServersSessionsBl.getlocalServerSession(localServer.localServerId);
            /** Check if hash of local server cert key is same as session hash key  */
            if (cryptoJs.SHA512(certAuth.remoteAuthKey + config_1.Configuration.keysHandling.saltHash).toString() !== localServerSession.keyHash) {
                throw new Error('key not match');
            }
            /** If there is other channel from same local server */
            if (this.localChannelsMap[certAuth.macAddress]) {
                /** Remove authentication for any case.  */
                this.localChannelsMap[certAuth.macAddress].machineMac = null;
                /** Need to test the behavior of local server when closing old connection manualy  */
                this.localChannelsMap[certAuth.macAddress].close();
                delete this.localChannelsMap[certAuth.macAddress];
            }
            /**
             * Mark ws channel local server machine (mac) address.
             * used to auth and correct route in next messages.
             */
            wsChannel.machineMac = certAuth.macAddress;
            /** Hold the channel after auth seccess. */
            this.localChannelsMap[certAuth.macAddress] = wsChannel;
            /** Send local server authenticatedSuccessfuly message. */
            this.sendMessage(wsChannel, { remoteMessagesType: 'authenticatedSuccessfuly', message: {} });
            this.localServersBl.setLocalServerConnectionStatus(localServer.localServerId, true);
        }
        catch (error) {
            /** send generic auth fail message */
            this.sendMessage(wsChannel, {
                remoteMessagesType: 'authenticationFail',
                message: {
                    authenticationFail: {
                        responseCode: 3403,
                        message: 'authorization of local server in remote, fail',
                    },
                },
            });
            /** wait a while until closing, to allow local server process fail message */
            setTimeout(() => {
                try {
                    this.localChannelsMap[certAuth.macAddress].close();
                }
                catch (error) { }
            }, 4000);
        }
    }
    /**
     * Handle feed message arrived from local sercer.
     * @param wsChannel local server ws object that message arrived from.
     * @param localServerFeed feed data.
     */
    async handleFeedUpdate(wsChannel, localServerFeed) {
        try {
            /** Get local server based on local server mac */
            const localServer = await this.localServersBl.getlocalServersByMac(wsChannel.machineMac);
            /** Send feed */
            this.localServersFeed.next({ localServerId: localServer.localServerId, localServerFeed });
        }
        catch (error) {
        }
    }
    /**
     * Handle get registered users of the certain local server.
     * @param wsChannel local server ws object that message arrived from.
     */
    async handleGetLocalUsers(wsChannel) {
        try {
            /** Get local server based on local server mac */
            const localServer = await this.localServersBl.getlocalServersByMac(wsChannel.machineMac);
            this.sendMessage(wsChannel, { remoteMessagesType: 'registeredUsers', message: { registeredUsers: localServer.validUsers } });
        }
        catch (error) {
        }
    }
    /**
     * Handle http response messages from local server.
     * @param httpResponse response data.
     */
    handleHttpResponse(httpResponse) {
        /** Get request promise methods */
        const sentRequest = this.sentHttpRequestsMap[httpResponse.requestId];
        /** If timeout activation delete it. there is nothing else to do. */
        if (!sentRequest) {
            /** Too late... */
            return;
        }
        /** Remove request promise from map */
        delete this.sentHttpRequestsMap[httpResponse.requestId];
        /** Activate promise resolve method with response as is. */
        sentRequest.forwardPromise.resolve(httpResponse);
    }
    /**
     * Send register authentication code to email account.
     * @param userForwardRequest email account to send for.
     */
    async handleSendRegistrationCodeRequest(userForwardRequest) {
        const { email } = userForwardRequest;
        /** Generate random MFA key. */
        const code = randomstring.generate({
            charset: 'numeric',
            length: 6,
        });
        try {
            await mailSender_1.SendMail(email, code);
            this.forwardUserReqAuth[email] = {
                code,
                timestamp: new Date().getTime(),
            };
        }
        catch (error) {
            logger_1.logger.warn(`Sent auth user account for local server forwarding fail ${JSON.stringify(error)}`);
        }
    }
    /**
     * Register account to allow forward HTTP requests from remote to local server
     * @param wsChannel The local server ws channel to add account for.
     * @param userForwardRequest The request data
     */
    async handleRegisterAccountRequest(wsChannel, userForwardRequest) {
        const { email, code } = userForwardRequest;
        if (this.forwardUserReqAuth[email] &&
            this.forwardUserReqAuth[email].code === code &&
            new Date().getTime() - this.forwardUserReqAuth[email].timestamp < momoent.duration(5, 'minutes').asMilliseconds()) {
            delete this.forwardUserReqAuth[email];
            try {
                const localServer = await this.localServersBl.getlocalServersByMac(wsChannel.machineMac);
                await this.localServersBl.addAccountForwardValid(localServer.localServerId, email);
                this.sendMessage(wsChannel, {
                    remoteMessagesType: 'registerUserResults',
                    message: {
                        registerUserResults: {
                            user: email,
                        },
                    },
                });
            }
            catch (error) {
                this.sendMessage(wsChannel, {
                    remoteMessagesType: 'registerUserResults',
                    message: {
                        registerUserResults: {
                            user: email,
                            results: error,
                        },
                    },
                });
            }
            return;
        }
        this.sendMessage(wsChannel, {
            remoteMessagesType: 'registerUserResults',
            message: {
                registerUserResults: {
                    user: email,
                    results: {
                        message: 'user or code invalied',
                        responseCode: 6403,
                    },
                },
            },
        });
    }
    /**
     * Remove account from local server valid account to forward from remote to local
     * @param wsChannel The local server ws channel to remove from.
     * @param userForwardRequest The account to remove.
     */
    async handleUnregisterAccountRequest(wsChannel, userForwardRequest) {
        const { email } = userForwardRequest;
        try {
            const localServer = await this.localServersBl.getlocalServersByMac(wsChannel.machineMac);
            await this.localServersBl.removeAccountForwardValid(localServer.localServerId, email);
            await this.forwardUsersSessionsBl.deleteUserSessions(email);
            this.sendMessage(wsChannel, {
                remoteMessagesType: 'registerUserResults',
                message: {
                    registerUserResults: {
                        user: email,
                    },
                },
            });
        }
        catch (error) {
            this.sendMessage(wsChannel, {
                remoteMessagesType: 'registerUserResults',
                message: {
                    registerUserResults: {
                        user: email,
                        results: error,
                    },
                },
            });
        }
    }
    /** Send http request to local server over ws channel. */
    async sendHttpViaChannelsByMac(localMac, httpRequest) {
        const localServer = await this.localServersBl.getlocalServersByMac(localMac);
        return await this.sendHttpViaChannels(localServer.localServerId, httpRequest);
    }
    /**
     * Send http request to local server over ws channel.
     * @param localServerId local server to send rrquest for.
     * @param httpRequest http request message to send.
     * @returns Http response message.
     */
    async sendHttpViaChannels(localServerId, httpRequest) {
        /** Try getting require local server  */
        const localServer = await this.localServersBl.getlocalServersById(localServerId);
        /**
         * Create promise to allow hold resolve/reject in map and wait for local server response.
         * (like we already know, ws is message based and not req/res based).
         */
        return new Promise((resolveHttpReq, rejectHttpReq) => {
            /** Get correct local server ws channel */
            const localServeChannel = this.localChannelsMap[localServer.macAddress];
            /** If channel not exist, mean there is no communication with local server. */
            if (!localServeChannel) {
                /** Send local server not availbe response */
                resolveHttpReq({
                    requestId: httpRequest.requestId,
                    httpBody: {
                        responseCode: 4501,
                        message: 'There is no connection to local server.',
                    },
                    httpStatus: 501,
                    httpSession: undefined,
                });
                return;
            }
            /** Generate uniqe id to each request to know witch response belong to current request  */
            const reqId = randomstring.generate(16);
            httpRequest.requestId = reqId;
            /** Add request promise methods to map  */
            this.sentHttpRequestsMap[reqId] = {
                timeStamped: new Date(),
                forwardPromise: {
                    reject: rejectHttpReq,
                    resolve: resolveHttpReq,
                },
            };
            /** Send request to local server to procces it. */
            this.sendMessage(localServeChannel, {
                remoteMessagesType: 'httpRequest',
                message: {
                    httpRequest,
                },
            });
        });
    }
    /**
     * On ws just opend.
     * @param wsChannel local server incomming ws.
     */
    onWsOpen(wsChannel) {
        /** Send to local server ready to init and auth message. */
        this.sendMessage(wsChannel, { remoteMessagesType: 'readyToInitialization', message: {} });
    }
    /**
     * On message arrived from local server.
     * @param wsChannel local server ws channel.
     * @param localMessage message content.
     */
    async onWsMessage(wsChannel, localMessage) {
        /** If it`s init message handle it, else check access cert befor handling. */
        if (localMessage.localMessagesType === 'initialization') {
            await this.handleInitializationRequest(wsChannel, localMessage.message.initialization);
            return;
        }
        /** If ws object not own machine mac, dont allow it to do anything. */
        if (!(wsChannel.machineMac in this.localChannelsMap)) {
            logger_1.logger.debug(`aborting local server message, there is no vaild mac address stamp.`);
            return;
        }
        /** Make sure local server session is valid. */
        try {
            const localServer = await this.localServersBl.getlocalServersByMac(wsChannel.machineMac);
            await this.localServersSessionsBl.getlocalServerSession(localServer.localServerId);
        }
        catch (error) {
            logger_1.logger.debug(`aborting local server message handling, there is no vaild session.`);
            return;
        }
        /** Route message to correct handler. */
        switch (localMessage.localMessagesType) {
            case 'httpResponse':
                this.handleHttpResponse(localMessage.message.httpResponse);
                break;
            case 'ack':
                this.sendMessage(wsChannel, { remoteMessagesType: 'ackOk', message: {} });
                break;
            case 'sendRegistrationCode':
                this.handleSendRegistrationCodeRequest(localMessage.message.sendRegistrationCode);
                break;
            case 'registerAccount':
                this.handleRegisterAccountRequest(wsChannel, localMessage.message.registerAccount);
                break;
            case 'unregisterAccount':
                this.handleUnregisterAccountRequest(wsChannel, localMessage.message.unregisterAccount);
                break;
            case 'registeredUsers':
                await this.handleGetLocalUsers(wsChannel);
                break;
            case 'feed':
                await this.handleFeedUpdate(wsChannel, localMessage.message.feed);
                break;
        }
    }
    /**
     * On any ws channel closed, from any reasone.
     * @param wsChannel closed ws channel.
     */
    async onWsClose(wsChannel) {
        /** If channel not passed auth, just return */
        if (!wsChannel.machineMac) {
            return;
        }
        /** Remove it from channel map. */
        delete this.localChannelsMap[wsChannel.machineMac];
        /** Try to set local server status to be off. */
        try {
            /** Get the local server based on cert mac address. */
            const localServer = await this.localServersBl.getlocalServersByMac(wsChannel.machineMac);
            this.localServersBl.setLocalServerConnectionStatus(localServer.localServerId, false);
        }
        catch (error) {
        }
    }
    /**
     * Send remote message to local server.
     * @param wsChannel ws to send by.
     * @param remoteMessage message to send.
     */
    sendMessage(wsChannel, remoteMessage) {
        try {
            wsChannel.send(JSON.stringify(remoteMessage));
        }
        catch (error) { }
    }
}
exports.ChannelsBl = ChannelsBl;
exports.ChannelsBlSingleton = new ChannelsBl(localServersBl_1.LocalServersBlSingleton, localServersSessionsBl_1.LocalServersSessionBlSingleton, forwardUserSessionsBl_1.ForwardUsersSessionsBlSingleton);
//# sourceMappingURL=channelsBl.js.map