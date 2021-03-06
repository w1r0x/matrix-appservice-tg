"use strict";

var Promise = require("bluebird");

var MTProto = require("telegram-mtproto").MTProto;

var os = require("os");

// As registered at
//   https://my.telegram.org/auth?to=apps
var APP = {
    id: "57582",
    hash: "7e085c887f71c9f1480c3930547ac159",
    version: "0.0.1",
    langCode: "en",
    deviceModel: os.type().replace("Darwin", "OS_X"),
    systemVersion: os.platform() + "/" + os.release(),
};

// Maximum wait time for HTTP long-poll
var HTTP_MAXWAIT = 30 * 1000;  // 30 seconds

function TelegramGhost(opts) {
    this._main = opts.main;

    this._matrix_user = opts.matrix_user;

    this._client = null;

    this._user_id = opts.user_id || null;
    this._phoneNumber = null;
    this._data = opts.data || {};

    var data = this._data;
    if (data.dc && data["dc" + data.dc + "_auth_key"]) this.start();
}

TelegramGhost.fromSubentry = function(matrix_user, main, data) {
    var user_id = data.user_id;
    delete data.user_id;

    return new TelegramGhost({
        main: main,
        matrix_user: matrix_user,

        user_id: user_id,
        data: data,
    });
};

TelegramGhost.prototype.toSubentry = function() {
    return Object.assign({
        user_id: this._user_id,
    }, this._data);
};

TelegramGhost.prototype.start = function() {
    this._getClient().then((client) => {
        client.on("update", (update) => {
            try {
                this._onTelegramUpdate(update);
            }
            catch (e) {
                console.log("Telegram update failed:", e);
            }
        });

        // You have to call updates.getState() once on startup for your
        //   session to be able to receive updates at all

        this._main.incRemoteCallCounter("account.updateStatus");
        client("account.updateStatus", {offline: false}).then(() => {
            return client("updates.getState", {});
        }).then((state) => {
            console.log("Got initial state:", state);
        });

        console.log("STARTed");
    }).catch((err) => {
        console.log("Failed to START -", err);
    });
};

TelegramGhost.prototype._getClient = function() {
    if (this._client) return Promise.resolve(this._client);

    var main = this._main;

    main.incRemoteCallCounter("connect");
    var client = MTProto({
        layer: 57,
        api_id: APP.id,
        app: {
          storage: {
            get: (key) => {
                var value = this._data[key];
                if (key.match(/_auth_key$/)) {
                    value = main.decipherAuthKey(value);
                }
                return Promise.resolve(value);
            },
            set: (key, value) => {
                if (key.match(/_auth_key$/)) {
                    value = main.encipherAuthKey(value);
                }

                if(this._data[key] === value) return Promise.resolve();

                this._data[key] = value;
                return this._matrix_user._updated();
            },
            remove: (...keys) => {
                keys.forEach((key) => delete this._data[key]);
                return this._matrix_user._updated();
            },
            clear: () => {
                this._data = {};
                return this._matrix_user._updated();
            },
          },
        },
    });

    return Promise.resolve(client);
};

TelegramGhost.prototype.sendCode = function(phone_number) {
    var main = this._main;

    return this._getClient().then((client) => {
        console.log("> Requesting auth code");
        main.incRemoteCallCounter("auth.sendCode");

        return client("auth.sendCode", {
            phone_number:   phone_number,
            current_number: true,
            api_id:         APP.id,
            api_hash:       APP.hash,
        }, { dcID: 2 });
    });
};

TelegramGhost.prototype._handleAuthorization = function(authorization) {
    console.log("auth.signIn succeeded:", authorization);

    this._user_id = authorization.user.id;
    this.start();

    return null;
}

TelegramGhost.prototype.signIn = function(phone_number, phone_code_hash, phone_code) {
    return this._getClient().then((client) => {
        this._main.incRemoteCallCounter("auth.signIn");
        this._phoneNumber = phone_number;

        return client("auth.signIn", {
            phone_number:    phone_number,
            phone_code:      phone_code,
            phone_code_hash: phone_code_hash
        }, { dcID: 2 });
    }).then(
        // Login succeeded - user is not using 2FA
        (result) => this._handleAuthorization(result),
        (err) => {
            if (err.type !== "SESSION_PASSWORD_NEEDED") {
                // Something else went wrong
                throw err;
            }

            // User is using 2FA - more steps are required
            return this._getClient().then((client) => {
                this._main.incRemoteCallCounter("account.getPassword");
                return client("account.getPassword", {}).then((result) => {
                    return {
                        hint: result.hint,
                        current_salt: Buffer.from(result.current_salt), // convert from UIint8 array
                    };
                });
            });
        }
    );
};

TelegramGhost.prototype.checkPassword = function(password_hash) {
    return this._getClient().then((client) => {
        this._main.incRemoteCallCounter("auth.checkPassword");
        return client("auth.checkPassword", {
          password_hash: password_hash
        });
    }).then((result) => this._handleAuthorization(result));
};

TelegramGhost.prototype.sendMessage = function(peer, text) {
    // TODO: reliable message IDs

    return this._getClient().then((client) => {
        this._main.incRemoteCallCounter("messages.sendMessage");
        return client("messages.sendMessage", {
            peer:      peer.toInputPeer(),
            message:   text,
            random_id: Math.random() * (1<<30),
            /*
            null, null, null
            */
        });
    }).then((result) => {
        // TODO: store result.id somewhere
    });
};

TelegramGhost.prototype.sendMedia = function(peer, media) {
    // TODO: reliable message IDs

    return this._getClient().then((client) => {
        this._main.incRemoteCallCounter("messages.sendMedia");
        return client("messages.sendMedia", {
            peer:      peer.toInputPeer(),
            media:     media,
            random_id: Math.random() * (1<<30),
        });
    }).then((result) => {
        // TODO: store result.id somewhere
    });
};

TelegramGhost.prototype.getFile = function(location) {
    return this._getClient().then((client) => {
        this._main.incRemoteCallCounter("upload.getFile");
        return client("upload.getFile", {
            location: location,
            offset:   0,
            limit:    100*1024*1024,
        });
    });
};

TelegramGhost.prototype.uploadFile = function(bytes, name) {
    // TODO: For now I'm going to presume all files are small enough to
    //   upload in a single part

    var id = Math.trunc(Math.random() * (1<<62));

    return this._getClient().then((client) => {
        this._main.incRemoteCallCounter("upload.saveFilePart");
        return client("upload.saveFilePart", {
            file_id: id,
            file_part: 0,
            bytes: bytes,
        }).then((result) => {
            console.log("Uploading part 0 returned", result);
        });
    }).then(() => {
        return {
            _: "inputFile",
            id: id,
            parts: 1,
            name: name,
            md5_checksum: "",  // TODO?
        };
    });
};

TelegramGhost.prototype.getChatInfo = function(peer) {
    if (peer._type === "user") throw new Error("Cannot get chat info on users");

    var main = this._main;

    return this._getClient().then((client) => {
        // For a chat, getFullChat really does that
        if (peer._type === "chat"   ) {
            main.incRemoteCallCounter("messages.getFullChat");
            return Promise.all([
                client("messages.getFullChat", {
                    chat_id: peer._id,
                }),
                Promise.resolve(null),
            ]);
        }
        // For a channel, getFullChannel doesn't return participants, so we need to make two calls
        if (peer._type === "channel") {
            main.incRemoteCallCounter("channels.getFullChannel");
            main.incRemoteCallCounter("channels.getParticipants");
            return Promise.all([
                client("channels.getFullChannel", {
                    channel: peer.toInputChannel(),
                }),
                client("channels.getParticipants", {
                    channel: peer.toInputChannel(),
                    filter:  { _: "channelParticipantsRecent" },
                    offset:  0,
                    limit:   1000,
                }),
            ]);
        }
        throw new Error("Impossible");
    }).spread((ret, participants) => {
        console.log("ChannelInfo was", ret, participants);

        // Assemble all the useful information about the chat
        var users = participants ? participants.users : ret.users;
        var chat = ret.chats[0];

        if (!participants) participants = ret.full_chat.participants;

        var users_by_id = {};
        users.forEach((user) => users_by_id[user.id] = user);

        return {
            title:        chat.title,
            participants: participants.participants.map((p) => users_by_id[p.user_id]),
        };
    });
};

TelegramGhost.prototype._onTelegramUpdate = function(upd) {
    switch(upd._) {
        case "updateShort":
            this._onOneUpdate(upd.update);
            break;

        case "updates":
            var users = upd.users;

            upd.updates.forEach((update) => {
                this._onOneUpdate(update, {
                    users: users,
                });
            });
            break;

        case "updateShortChatMessage":
            this._onOneUpdate(upd);
            break;

        default:
            console.log(`TODO: unrecognised updates toplevel type ${upd._}:`, upd);
            break;
    }
};

TelegramGhost.prototype._onOneUpdate = function(update, hints) {
    hints = hints || {};

    switch(update._) {
        // Updates about Users
        case "updateUserStatus":
        case "updateUserTyping":
            // Quiet these for now as they're getting really noisy
            //console.log(`UPDATE: user status user_id=${update.user_id} _t=${update.status._typeName}`);
            break;

        // Updates about Chats
        case "updateChatUserTyping":
        case "updateShortChatMessage":
        {
            console.log(`UPDATE about CHAT ${update.chat_id}`);
            var peer = this.newChatPeer(update.chat_id);

            hints.from_id = update.from_id;

            this._main.onTelegramUpdate(this._matrix_user, peer, update, hints);
            break;
        }

        // Updates about Channels
        //   - where the channel ID is part of the 'message'
        case "updateNewChannelMessage":
        case "updateEditChannelMessage":
        {
            console.log(`UPDATE about CHANNEL ${update.message.to_id.channel_id}`);
            var peer = new Peer("channel", update.message.to_id.channel_id);

            if (update.message.out) {
                // Channel messages from myself just have the "out" flag and
                // omit the from_id
                hints.from_id = this._user_id;
            }
            else {
                hints.from_id = update.message.from_id;
            }

            this._main.onTelegramUpdate(this._matrix_user, peer, update, hints);
            break;
        }

        //   - where the channel ID is toplevel
        case "updateReadChannelInbox":
        {
            console.log(`UPDATE about CHANNEL ${update.channel_id}`);
            var peer = new Peer("channel", update.channel_id);

            this._main.onTelegramUpdate(this._matrix_user, peer, update, hints);
            break;
        }

        // Updates that could be about Users, Chats or Channels
        case "updateNewMessage":
        {
            console.log(`UPDATE about peer type ${update.message.to_id._}`);
            var peer = Peer.fromTelegramPeer(update.message.to_id);

            this._main.onTelegramUpdate(this._matrix_user, peer, update, hints);
            break;
        }

        // Updates about myself
        case "updateReadHistoryInbox":
        case "updateReadHistoryOutbox":
        case "updateReadChannelInbox":
        case "updateReadChannelOutbox":
            // ignore it for now
            break;

        default:
            console.log(`TODO: unrecognised update type ${update._}:`, update);
            break;
    }
};

// A "Peer" is a little helper object that stores a type (user|chat|channel),
//   its ID and the access_hash used to prove this user can talk to it

TelegramGhost.prototype.newChatPeer = function(id) {
    return new Peer("chat", id);
};

TelegramGhost.prototype.newChannelPeer = function(id, access_hash) {
    return new Peer("channel", id, access_hash);
};

function Peer(type, id, access_hash) {
    this._type        = type;
    this._id          = id;
    this._access_hash = access_hash;
}

/* Convert from a `telegram-mtproto` Peer instance */
Peer.fromTelegramPeer = function(peer) {
    switch(peer._) {
        case "peerChat":
            return new Peer("chat", peer.chat_id);
        case "peerChannel":
            return new Peer("channel", peer.channel_id, peer.access_hash);
        default:
            throw new Error(`Unrecognised peer type ${peer._}`);
    }
};

Peer.fromSubentry = function(entry) {
    var access_hash = entry.access_hash ? new Buffer(entry.access_hash) : null;

    return new Peer(entry.type, entry.id, access_hash);
};

Peer.prototype.toSubentry = function() {
    return {
        type:        this._type,
        id:          this._id,
        access_hash: this._access_hash.toString(),
    };
};

Peer.prototype.getKey = function() {
    return [this._type, this._id].join(" ");
};

Peer.prototype.toInputPeer = function() {
    switch(this._type) {
        case "chat":
            return {
                _: "inputPeerChat",
                chat_id: this._id,
            };

        case "channel":
            return {
                _: "inputPeerChannel",
                channel_id:  this._id,
                access_hash: this._access_hash,
            };

        default:
            throw new Error(`Cannot .toInputPeer() a peer of type ${this._type}`);
    }
};

Peer.prototype.toInputChannel = function() {
    if (this._type !== "channel") throw new Error(`Cannot .toInputChannel() a peer of type ${this._type}`);

    return {
        _: "inputChannel",
        channel_id:  this._id,
        access_hash: this._access_hash,
    };
}

module.exports = TelegramGhost;
TelegramGhost.Peer = Peer;
