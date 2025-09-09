const EventEmitter = require("events");
const WebSocket =  typeof window==='object'?window.WebSocket:require("ws");

class Client extends EventEmitter {
    #username;
    #linkedRooms;
    #handshakeTimeout;
    #awaitingListeners = {};
    constructor(){
        super();
        this.ws = null;
        this.userObject = {};
        this.userList = [];
        this.motd = '';
        this.ip = null;
        this.connected = false;
        this.serverVersion = null;

        this.globalMessage = '';
        this.globalVariables = new Map;
        this.privateMessage = '';
        this.privateVariables = new Map;

        this.#username = null;
        this.#linkedRooms = ['default'];
        this.#awaitingListeners = {};
        this.#handshakeTimeout = null;
    }
    #unlink(){
        this.ws = null;
        this.userObject = {};
        this.userList = [];
        this.motd = '';
        this.ip = null;
        this.connected = false;
        this.serverVersion = null;

        this.globalMessage = '';
        this.globalVariables = new Map;
        this.privateMessage = '';
        this.privateVariables = new Map;

        this.#username = null;
        this.#linkedRooms = ['default'];
        this.#awaitingListeners = {};
        this.#handshakeTimeout = null;
    }
    #send(json, listener){
        if(!this.ws) return
        if(listener){
            this.ws.send(JSON.stringify({...json, ...{listener}}))
            return new Promise((resolve, reject) => {
                this.#awaitingListeners[listener] = [resolve, reject]
            })
        }else{
            this.ws.send(JSON.stringify(json))
        }
            
    }
    async #processMessage(msg){
        let json;
        try{
            json = JSON.parse(msg)
        }catch{
            return; //Server message could not be parsed as valid json, ignore.
        }
        switch(json.cmd){
            case 'statuscode':
                if(this.#awaitingListeners[json.listener]){
                    this.#awaitingListeners[json.listener][json.code_id>100?1:0](json.code_id>100?json.code_id:json.val);
                    delete this.#awaitingListeners[json.listener];
                }
                break;
            case 'client_ip': this.ip = json.val; break;
            case 'server_version': 
                if(json.val.split('0.')[1]<2){
                    this.#unlink();
                    throw new Error('cloudlink.js only supports connecting to server versions 0.2.0 or up.')
                }
                this.serverVersion = json.val;
                clearTimeout(this.#handshakeTimeout);
                break;
            case 'motd': this.motd = json.val; break;
            case 'client_object': this.userObject = json.val; break;
            case 'ulist':
                switch(json.mode){
                    case 'set': this.userList = json.val; break;
                    case 'add': this.userList.push(json.val); break;
                    case 'remove': this.userList.slice(this.userList.indexOf(json.val), 1); break;
                };
                break;
            case 'gmsg':
                if(!this.#linkedRooms.includes(json.rooms)) return;
                    this.globalMessage = json.val;
                    this.emit('globalMessage', json.val);
                break;
            case 'gvar':
                if(!this.#linkedRooms.includes(json.rooms)) return;
                this.globalVariables.set(json.name, json.val);
                this.emit('globalVariable', json.name, json.val);
                break;
            case 'pmsg':
                if(!this.#linkedRooms.includes(json.rooms)) return;
                this.privateMessage = json.val;
                this.emit('privateMessage', json.val, json.origin);
                break;
            case 'pvar':
                if(!this.#linkedRooms.includes(json.rooms)) return;
                this.privateVariables.set(json.name, json.val);
                this.emit('privateVariable', json.name, json.val, json.origin);
                break;
            
            
        }
    }
    /**
     * @param {string} url WebSocket url to connect to (Mikes default server if none)
     */
    connect(url="wss://cl.mikedev101.cc/"){ //default to mikedevs server
        const ws = new WebSocket(url);
        ws.on('open', () => {
            this.#handshakeTimeout = setTimeout(() => {
                this.#send({cmd: "handshake", val: {language: "JS", version: {node: process.version.split('v')[1], module: require('../package.json').version}}}, "handshake_cfg")
                    .then(() => {
                        this.connected = true;
                        this.emit('connected');
                    })
                    .catch(c => {
                        this.#unlink();
                        throw new Error('Failed to connect to server. Server message: '+c)
                    })
            }, 500)
        });
        ws.on('message', message => {
            this.#processMessage(message)
        });
        this.ws = ws;
    }
    /**
     * Disconnects from the connected cloudlink server
     */
    disconnect(){
        if(typeof this.#handshakeTimeout === 'function')
            clearTimeout(this.#handshakeTimeout);
        this.#unlink()


        this.emit('disconnected');
    }
    /**
     * Sends a global message to all users
     * @param {string} message Message to send
     */
    sendGlobalMessage(message){
        this.#send({cmd: "gmsg", val: message});
    }
    /**
     * Sends a global variable to all users
     * @param {string} name Variable name
     * @param {string} value Variable value as string
     */
    sendGlobalVariable(name, value){
        this.#send({cmd: "gvar", name, val: value})
    }
    /**
     * Sends a private message to a specific user
     * @param {string} target Username to send to
     * @param {string} message Message to send
     */
    sendPrivateMessage(target, message){
        if(!this.#username){
            console.warn('Username must be set before sending private messages/variables!');
            return;
        }
        this.#send({cmd: "pmsg", val: message, id: target})
    }
    /**
     * Sends a private variable to a specific user
     * @param {string} target Username to send to
     * @param {string} name Variable name
     * @param {string} value Variable value
     */
    sendPrivateVariable(target, name, value){
        if(!this.#username){
            console.warn('Username must be set before sending private messages/variables!');
            return;
        }
        this.#send({cmd: "pvar", val: value, name, id: target});
    }
    /**
     * Send a custom command specified to the server
     * @param {string} name Name of command to send
     * @param {string} value Value of command to send
     * @param {string} id Id of command to send (optional)
     */
    sendCustomCommand(name, value, id){
        this.#send({cmd: name, val: value, ...(id?id:{})})
    }
    get username(){return this.#username||''}
    set username(val){
        this.#send({cmd: "setid", val}, "username_cfg")
        .then(result => {
            this.userObject = result;
            this.#username = result.username;
            this.emit('usernameSet', result.username)
        })
        .catch(error => {
            this.emit('usernameError', error)
        })
    }
    get rooms(){return this.#linkedRooms}
    set rooms(roomsArr){
        if(!this.ws || !this.#username) return;
        this.#send({cmd: 'link', val: roomsArr}, "link")
        .then(() => {
            this.#linkedRooms = roomsArr;
            this.emit('connectedToRooms', roomsArr)
        })
        .catch(e => {
            throw new Error('Failed to link to rooms: '+e)
        })
    }
}

module.exports = Client;