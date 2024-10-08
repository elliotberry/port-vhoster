import httpProxy from 'http-proxy';
import {argv} from 'optimist';
export default (() => {
   
    let configFileName = 'port-vhoster.json';
    let routingConfig = {};
    let proxyServer;


    // Use different config file if named
    if (argv._[0]) {
        configFileName = argv._[0];
    }

    // Read routing config
    routingConfig = JSON.parse(require('fs').readFileSync(
        require('path').resolve(process.cwd(), configFileName), 'utf8')
    );

    // Validate routing config
    if (!routingConfig.port) {
        throw new Error('No source listening port given!');
    }

    if (!routingConfig.vhosts) {
        throw new Error('No vhost config given!');
    }

    try {

        // Logging
        if (routingConfig.description) {
            console.log(routingConfig.description);
        }

        // Create proxy server
        proxyServer = httpProxy.createServer({
            router: routingConfig.vhosts
        });

        // Listen on source port
        proxyServer.listen(routingConfig.port);

    } catch (e) {
        throw e;
    }

    return {

        cli() {

            // Get the current directory
            const cwd = process.cwd();
            console.log("Current working directory: ", cwd);
            console.log(`Arguments given: ${process.argv.slice(2)}`);
        }
    };
})();