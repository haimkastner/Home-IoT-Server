import * as cryptoJs from 'crypto-js';
import * as moment from 'moment';
import * as momoent from 'moment';
import * as randomstring from 'randomstring';
import { BehaviorSubject, Observable, Subscriber } from 'rxjs';
import * as ws from 'ws';
import { Configuration } from '../../../backend/src/config';
import { HttpRequest, HttpResponse, LocalMessage, LocalServerFeed, RemoteMessage } from '../../../backend/src/models/remote2localProtocol';
import { ErrorResponse, MinionFeed, TimingFeed } from '../../../backend/src/models/sharedInterfaces';
import { logger } from '../../../backend/src/utilities/logger';
import { SendMail } from '../../../backend/src/utilities/mailSender';
import { checkSession, getServer, updateServer } from '../data-access';

/**
 * Extend ws to allow hold uniqe id to each authenticated local server ws channel.
 * This id allow to route user requests to correct local server.
 */
export interface CasaWs extends ws {
    /**
     * uniqe identity each local servers.
     * (Don`t use local server id, becuase local server dont know it.)
     */
    machineMac: string;
}

/**
 * Manage all local servers ws I/O messages.
 * The main goal is to allow used ws protocol as req/res architecture.
 * So when user send HTTP request it will forward to local server via ws and
 * returns response, evan thet ws is messages architecture based.
 */
export class Channels {

    /**
     * Timeout for any http request.
     * (it long time bacuse of scaning network request that takes a while.)
     */
    private httpRequestTimeout: moment.Duration = moment.duration(2, 'minutes');

    /** Map all local servers ws channel by local server mac address */
    private localChannelsMap: { [key: string]: CasaWs } = {};

    /**
     * Hold each request promise reject/resolve methods.
     * until message will arrive from local server with response for current request.
     */
    private sentHttpRequestsMap: {
        [key: string]: {
            timeStamped: Date,
            forwardPromise: {
                resolve: (httpResponse: HttpResponse) => {},
                reject: (errorResponse: ErrorResponse) => {},
            },
        },
    } = {};

    /**
     * Register generated code map to account with creation timestamp.
     */
    private forwardUserReqAuth: {
        [key: string]:
        {
            code: string;
            timestamp: number;
        };
    } = {};

    /** Feed of local servers feeds. */
    public localServersFeed = new BehaviorSubject<{ localServerId: string, localServerFeed: LocalServerFeed }>(undefined);

    constructor() {
        /** Invoke requests timeout activation. */
        this.setTimeoutRequestsActivation();
    }

    /**
     * Timeout of each request activation.
     * Used to clean up and send timeout response to requestes
     * that local server not answer to them.
     */
    private setTimeoutRequestsActivation() {
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
    private async handleInitializationRequest(wsChannel: CasaWs, certAuth: { macAddress: string, remoteAuthKey: string }) {

        try {
            /** Get the local server based on cert mac address. */
            const localServer = await getServer(certAuth.macAddress);

            await checkSession(localServer, cryptoJs.SHA512(certAuth.remoteAuthKey + Configuration.keysHandling.saltHash).toString());

            /** If there is other channel from same local server */
            if (this.localChannelsMap[certAuth.macAddress]) {
                /** Remove authentication for any case.  */
                this.localChannelsMap[certAuth.macAddress].machineMac = null;

                /** Need to test the behavior of local server when closing old connection manualy  */
                try { this.localChannelsMap[certAuth.macAddress].close(); } catch (err) { }

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

            logger.info(`Local server ${localServer.displayName} connected succefully`);
        } catch (error) {

            logger.debug(`Fail to authenticate local server ${JSON.stringify(error)}`);

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
                try { this.localChannelsMap[certAuth.macAddress].close(); } catch (error) { }
            }, 4000);
        }
    }

    /**
     * Handle feed message arrived from local sercer.
     * @param wsChannel local server ws object that message arrived from.
     * @param localServerFeed feed data.
     */
    private async handleFeedUpdate(wsChannel: CasaWs, localServerFeed: LocalServerFeed) {

        try {
            /** Send feed */
            this.localServersFeed.next({ localServerId: wsChannel.machineMac, localServerFeed });
        } catch (error) {
            logger.warn(`sending feed from local server to clients fail ${JSON.stringify(error)}`);
        }
    }

    /**
     * Handle get registered users of the certain local server.
     * @param wsChannel local server ws object that message arrived from.
     */
    private async handleGetLocalUsers(wsChannel: CasaWs) {

        try {
            /** Get local server based on local server mac */
            const localServer = await getServer(wsChannel.machineMac);

            this.sendMessage(wsChannel, { remoteMessagesType: 'registeredUsers', message: { registeredUsers: localServer.validUsers } });
        } catch (error) {
            logger.warn(`sending to local server his valid users fail ${JSON.stringify(error)}`);
        }
    }

    /**
     * Handle http response messages from local server.
     * @param httpResponse response data.
     */
    private handleHttpResponse(httpResponse: HttpResponse) {
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
    private async handleSendRegistrationCodeRequest(userForwardRequest: { email: string; }) {

        const { email } = userForwardRequest;

        /** Generate random MFA key. */
        const code = randomstring.generate({
            charset: 'numeric',
            length: 6,
        });

        try {

            await SendMail(email, code);
            this.forwardUserReqAuth[email] = {
                code,
                timestamp: new Date().getTime(),
            };
        } catch (error) {
            logger.warn(`Sent auth user account for local server forwarding fail ${JSON.stringify(error)}`);
        }
    }

    /**
     * Register account to allow forward HTTP requests from remote to local server
     * @param wsChannel The local server ws channel to add account for.
     * @param userForwardRequest The request data
     */
    private async handleRegisterAccountRequest(wsChannel: CasaWs, userForwardRequest: { email: string; code: string; }) {

        const { email, code } = userForwardRequest;

        if (this.forwardUserReqAuth[email] &&
            this.forwardUserReqAuth[email].code === code &&
            new Date().getTime() - this.forwardUserReqAuth[email].timestamp < momoent.duration(5, 'minutes').asMilliseconds()) {

            delete this.forwardUserReqAuth[email];

            try {
                const localServer = await getServer(wsChannel.machineMac);
                if (localServer.validUsers.indexOf(email) === -1) {
                    localServer.validUsers.push(email);
                    await updateServer(localServer);
                }

                this.sendMessage(wsChannel, {
                    remoteMessagesType: 'registerUserResults',
                    message: {
                        registerUserResults: {
                            user: email,
                        },
                    },
                });
            } catch (error) {
                logger.warn(`Registar user account for local server forwarding fail ${JSON.stringify(error)}`);
                this.sendMessage(wsChannel, {
                    remoteMessagesType: 'registerUserResults',
                    message: {
                        registerUserResults: {
                            user: email,
                            results: {
                                responseCode: 5001,
                            },
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
    private async handleUnregisterAccountRequest(wsChannel: CasaWs, userForwardRequest: { email: string }) {

        const { email } = userForwardRequest;

        try {
            const localServer = await getServer(wsChannel.machineMac);
            if (localServer.validUsers.indexOf(email) !== -1) {
                localServer.validUsers.splice(localServer.validUsers.indexOf(email), 1);
                await updateServer(localServer);
            }

            this.sendMessage(wsChannel, {
                remoteMessagesType: 'registerUserResults',
                message: {
                    registerUserResults: {
                        user: email,
                    },
                },
            });
        } catch (error) {
            logger.warn(`Unegistar user account for local server forwarding fail ${JSON.stringify(error)}`);
            this.sendMessage(wsChannel, {
                remoteMessagesType: 'registerUserResults',
                message: {
                    registerUserResults: {
                        user: email,
                        results: {
                            responseCode: 5001,
                        },
                    },
                },
            });
        }
    }

    /**
     * Send http request to local server over ws channel.
     * @param localServerId local server phisical address to send request for.
     * @param httpRequest http request message to send.
     * @returns Http response message.
     */
    public async sendHttpViaChannels(localServerId: string, httpRequest: HttpRequest): Promise<HttpResponse> {

        /**
         * Create promise to allow hold resolve/reject in map and wait for local server response.
         * (like we already know, ws is message based and not req/res based).
         */
        return new Promise<HttpResponse>((resolveHttpReq, rejectHttpReq) => {
            /** Get correct local server ws channel */
            const localServeChannel = this.localChannelsMap[localServerId];

            /** If channel not exist, mean there is no communication with local server. */
            if (!localServeChannel) {
                /** Send local server not availbe response */
                resolveHttpReq({
                    requestId: httpRequest.requestId,
                    httpBody: {
                        responseCode: 4501,
                        message: 'There is no connection to local server.',
                    } as ErrorResponse,
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
                    reject: rejectHttpReq as () => {},
                    resolve: resolveHttpReq as () => {},
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
    public onWsOpen(wsChannel: ws) {
        /** Send to local server ready to init and auth message. */
        this.sendMessage(wsChannel, { remoteMessagesType: 'readyToInitialization', message: {} });
    }

    /**
     * On message arrived from local server.
     * @param wsChannel local server ws channel.
     * @param localMessage message content.
     */
    public async onWsMessage(wsChannel: CasaWs, localMessage: LocalMessage) {

        /** If it`s init message handle it, else check access cert befor handling. */
        if (localMessage.localMessagesType === 'initialization') {
            await this.handleInitializationRequest(wsChannel, localMessage.message.initialization);
            return;
        }

        /** If ws object not own machine mac, dont allow it to do anything. */
        if (!(wsChannel.machineMac in this.localChannelsMap)) {
            logger.debug(`aborting local server message, there is no vaild mac address stamp.`);
            return;
        }

        /** Route message to correct handler. */
        switch (localMessage.localMessagesType) {
            case 'httpResponse': this.handleHttpResponse(localMessage.message.httpResponse); break;
            case 'ack': this.sendMessage(wsChannel, { remoteMessagesType: 'ackOk', message: {} }); break;
            case 'sendRegistrationCode': this.handleSendRegistrationCodeRequest(localMessage.message.sendRegistrationCode); break;
            case 'registerAccount': this.handleRegisterAccountRequest(wsChannel, localMessage.message.registerAccount); break;
            case 'unregisterAccount': this.handleUnregisterAccountRequest(wsChannel, localMessage.message.unregisterAccount); break;
            case 'registeredUsers': await this.handleGetLocalUsers(wsChannel); break;
            case 'feed': await this.handleFeedUpdate(wsChannel, localMessage.message.feed); break;
        }
    }

    /**
     * On any ws channel closed, from any reasone.
     * @param wsChannel closed ws channel.
     */
    public async onWsClose(wsChannel: CasaWs) {
        /** If channel not passed auth, just return */
        if (!wsChannel.machineMac) {
            return;
        }

        /** Remove it from channel map. */
        delete this.localChannelsMap[wsChannel.machineMac];
    }

    /**
     * Disconnect local server channel.
     * @param macAddress local server physical address
     */
    public async disconnectLocalServer(macAddress: string) {

        const localServerConnection = this.localChannelsMap[macAddress];

        /** If channel not passed auth, just return */
        if (!localServerConnection) {
            return;
        }

        try { localServerConnection.close(); } catch (error) { }

        /** Remove it from channel map. */
        delete this.localChannelsMap[macAddress];
    }

    /**
     * Get channel connection status.
     * @param macAddress local server physical address
     */
    public async connectionStatus(macAddress: string): Promise<boolean> {
        return macAddress in this.localChannelsMap;
    }

    /**
     * Send remote message to local server.
     * @param wsChannel ws to send by.
     * @param remoteMessage message to send.
     */
    private sendMessage(wsChannel: ws, remoteMessage: RemoteMessage) {
        try { wsChannel.send(JSON.stringify(remoteMessage)); } catch (error) { }
    }
}

export const ChannelsSingleton = new Channels();
