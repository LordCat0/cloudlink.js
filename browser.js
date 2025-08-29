const Client = require('./lib/client.js')

class ServerError{
    constructor(){
        throw new Error('Cloudlink servers cannot be hosted on a web browser!')
    }
}

module.exports = { Server: ServerError, Client }