const EventEmitter = require("events");
const ws = require("ws");
const { v4: uuidv4 } = require('uuid');

const serverVersion = '0.2.0';

const statusNames = {
    0: "Test",
    1: "Echo",
    100: "OK",
    101: "Syntax",
    102: "Datatype",
    103: "ID not found",
    104: "ID not specific enough",
    105: "Internal server error",
    106: "Empty packet",
    107: "ID already set",
    108: "Refused",
    109: "Invalid command",
    110: "Command disabled",
    111: "ID required",
    112: "ID conflict",
    113: "Too large",
    114: "JSON error",
    115: "Room not joined"
}

class User {
    constructor(id, uuid, ip, ws){
        Object.defineProperties(this, {
            id: {
                value: id,
                writable: false,
                enumerable: true
            },
            uuid: {
                value: uuid,
                writable: false,
                enumerable: true
            },
            ip: {
                value: ip,
                writable: false,
                enumerable: true
            },
            ws: {
                value: ws,
                writable: false,
                enumerable: true
            }
        })
        this.username = undefined;
        this.platform = {};
        this.handshaked = false;
        this.linkedRooms = ['default'];
    }
    get [Symbol.toStringTag](){
        return "User";
    }
    /**
     * Kicks/Disconnects the user from the server
     */
    kick(){
        this.ws.close(1000)
    }
    /**
     * Sends a private message to the user
     * @param {string} message Message to send
     */
    sendPrivateMessage(message){
       this.ws.send(JSON.stringify({cmd: "pmsg", val: message}))
    }
    /**
     * Sends a private variable to the user
     * @param {string} name
     * @param {string} value
     */
    sendPrivateVariable(name, value){
        this.ws.send(JSON.stringify({cmd: "pvar", val: value, name: name}))
    }
}

class Server extends EventEmitter {
    #users;
    constructor(){
        super();
        this.websocket = undefined;
        this.#users = {};
        this.commands = {};
        /** Server message of the day that gets sent to users when they connect */
        this.motd = '';
        this.maxUsers = -1;
        /** Send packets to only the rooms it needs to, but comes at the cost of performance  */
        this.optimizeSending = false;
        /** Send the user IP back for "My IP address" block */
        this.proxyIp = false;

        this.globalMessage = '';
    }
    #findUser(id, clientRooms){
        return Object.values(this.#users)
            .find(u => u.username===id && 
                u.linkedRooms.find(room => clientRooms.includes(room))!==undefined
            ) || null
    } 
    #getUsersInRoom(room){
        return Object.values(this.#users)
            .filter(u => u.linkedRooms.includes(room))
    }
    #sendStatus(ws, code, listener, data){
        const codeName = statusNames[code]||"Unknown"
        ws.send(JSON.stringify({"cmd":"statuscode","code":`I:${code} | ${codeName}`,"code_id":code,"listener":listener,...(data&&{val:data})}))
        //if(code > 100 && code < 116)
        //    ws.close(3000+code)
    }
    #broadcast(json, rooms=['default']){
        for (const room of rooms){
            //this.#getUsersInRoom(room) //Only send data to clients in the rooms provided
            //   .forEach(u => u.ws.send(JSON.stringify({ ...json, ...{rooms: room } })))
                Object.values(this.#users).forEach(u => u.ws.send(JSON.stringify({ ...json, ...{rooms: room } })))
        }
    }
    #userToUserObject(user){
        return {id: user.id, uuid: user.uuid, ...(user.username?{username: user.username}:{})}
    }
    #processMessage(msg, client, req){
        //////
        console.log('Client message: '+msg)
        //////
        let json;
        try{
            json = JSON.parse(msg)
        }catch{
            this.#sendStatus(client.ws, 144);
            client.ws.close();
            return
        }
        if(!json.cmd){
            this.#sendStatus(client.ws, 101, json.listener)
        }
        if(!client.handshaked && json.cmd !== 'handshake')
            return //User has not handshaked, ignore the command
        switch(json.cmd){
            case 'handshake':
                client.handshaked = true;
                client.platform = json.val;
                if(this.proxyIp)
                    client.ws.send(JSON.stringify({"cmd":"client_ip","val":req.socket.remoteAddress}));
                client.ws.send(JSON.stringify({"cmd":"server_version","val":serverVersion}));
                if(this.motd !== '')
                    client.ws.send(JSON.stringify({"cmd":"motd","val":this.motd}));
                client.ws.send(JSON.stringify({cmd: "client_obj", val: {id: client.id, uuid: client.uuid}}));
                client.ws.send(JSON.stringify({cmd: "ulist", mode: "set", val: this.#getUsersInRoom('default').map(u => this.#userToUserObject(u))}));
                this.#sendStatus(client.ws, 100, json.listener);
                this.emit('userJoin', client);
                break;
                
            case 'setid':
                client.username = json.val;
                client.linkedRooms.forEach(room => 
                    this.#broadcast({cmd: "ulist", mode: "set", val: this.#getUsersInRoom(room).map(u => this.#userToUserObject(u)), rooms: room})
                );
                this.#sendStatus(client.ws, 100, json.listener, this.#userToUserObject(client))
                break;
            case 'link':
                client.linkedRooms = json.val;
                this.#broadcast({cmd: "ulist", mode: "set", val: this.#getUsersInRoom('default').map(u => this.#userToUserObject(u))});
                json.val.forEach(room => client.ws.send(JSON.stringify({cmd: "ulist", mode: "set", val: this.#getUsersInRoom(room).map(u => this.#userToUserObject(u)), rooms: room})));
                this.#sendStatus(client.ws, 100, json.listener)
                break;
            case 'unlink':
                const oldRooms = client.linkedRooms;
                client.linkedRooms = ['default'];
                oldRooms.forEach(room => client.ws.send(JSON.stringify({cmd: "ulist", mode: "set", val: this.#getUsersInRoom(room), rooms: room})));
                this.#broadcast({cmd: "ulist", mode: "set", val: this.#getUsersInRoom('default').map(u => this.#userToUserObject(u))});
                this.#sendStatus(client.ws, 100, json.listener);
                break;
            case 'gmsg': this.globalMessage = json.val; this.#broadcast({cmd: "gmsg", val: json.val}, client.linkedRooms); this.emit('globalMessage', json.val); break;
            case 'gvar': this.#broadcast({cmd: "gvar", val: json.val, name: json.name}, client.linkedRooms); break;
            case 'pmsg':
                const userpmsg = this.#findUser(json.id, client.linkedRooms);
                if(userpmsg)
                    userpmsg.ws.send(JSON.stringify({cmd: "pmsg", val: json.val}));
                break;
            case 'pvar':
                const userpvar = this.#findUser(json.id, client.linkedRooms);
                if(userpvar)
                    userpvar.ws.send(JSON.stringify({cmd: "pvar", val: json.val, name: json.name}));
                break;
            default:
                if(this.commands[json.cmd] && (typeof this.commands[json.cmd] === 'function')){
                    this.commands[json.cmd](client, json.val, json.id||null);
                }else{
                    this.#sendStatus(client.ws, 109, json.listener);
                }

        }
    }
    listen(port, callback){
        this.websocket = new ws.Server({ port });
        this.websocket.on('connection', (ws, req) => {
            const clientId = uuidv4();
            this.#users[clientId] = new User(String(Math.floor(Math.random() * 1e19)).padStart(19, '0'), clientId, req.socket.remoteAddress, ws);
            ws.on('message', msg => this.#processMessage(msg, this.#users[clientId], req));
            ws.on('close', () => {
                this.#broadcast({cmd: "ulist", mode: "remove"}, this.#users[clientId].linkedRooms)
                this.emit('userLeave', this.#users[clientId]);
                delete this.#users[clientId];
            });
        })
        this.websocket.on('listening', () => {
            if(typeof callback === 'function')
                callback();
            this.emit('listening');
        })
    }
    get users(){
        return Object.values(this.#users);
    }
    /**
     * Sends a global message to all users in a room (default if none)
     * @param {string} message Message to send
     * @param {Array} rooms Rooms to send to
     */
    sendGlobalMessage(message, rooms){
        this.#broadcast({ cmd: "gmsg", val: message }, rooms);
    }
    /**
     * Sends a global variable to all users in a room (default if none)
     * @param {string} name Variable name
     * @param {string} value Variable value
     * @param {Array} rooms Rooms to send to
     */
    sendGlobalVariable(name, value, rooms){
        this.globalMessage = value;
        this.#broadcast({cmd: "gvar", val: value, name: name}, rooms);
    }
}

module.exports = Server