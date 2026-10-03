import {buildApp} from "./app.js";

const app = buildApp();

async function start(){
    try{
        await app.listen({
            port:3000
        });
        app.log.info('Server started');
    }
    catch(e){
        app.log.error(e);
        process.exit(1);
    }
}

start();