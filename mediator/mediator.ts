/**
 * This file contains a sample mediator. The mediator supports both
 * HTTP and WebSockets for communication and will automatically accept
 * incoming mediation requests.
 *
 * You can get an invitation by going to '/invitation', which by default is
 * http://localhost:3001/invitation
 *
 * To connect to the mediator from another agent, you can set the
 * 'mediatorConnectionsInvite' parameter in the agent config to the
 * url that is returned by the '/invitation/ endpoint. This will connect
 * to the mediator, request mediation and set the mediator as default.
 */

import type { InitConfig } from '@aries-framework/core'
import type { Socket } from 'net'

import express from 'express'
import * as indySdk from 'indy-sdk'
import { Server } from 'ws'

import {
  ConnectionsModule,
  MediatorModule,
  HttpOutboundTransport,
  Agent,
  ConnectionInvitationMessage,
  LogLevel,
  WsOutboundTransport,
} from '@aries-framework/core'
import { IndySdkModule } from '@aries-framework/indy-sdk'
import {
  HttpInboundTransport,
  agentDependencies,
  IndySdkPostgresStorageConfig,
  IndySdkPostgresWalletScheme,
  loadIndySdkPostgresPlugin
} from '@aries-framework/node'
import MediatorLogger from "./logger";
import {WsInboundTransport} from "./WsInboundTransport";

const port = process.env.AGENT_PORT ? Number(process.env.AGENT_PORT) : 3001

// We create our own instance of express here. This is not required
// but allows use to use the same server (and port) for both WebSockets and HTTP
const app = express()
const socketServer = new Server({ noServer: true })

const endpoints = process.env.AGENT_ENDPOINTS?.split(',') ?? [`http://localhost:${port}`, `ws://localhost:${port}`]

const logger = new MediatorLogger(LogLevel.info)

const db_host = process.env.POSTGRESQL_HOST || "localhost"
const db_port = process.env.POSTGRESQL_PORT ? Number(process.env.POSTGRESQL_PORT) : 5432
logger.info(`Using PostgreSQL db @${db_host}:${db_port}`)

// IndySdkPostgresStorageConfig defines interface for the Postgres plugin configuration.
const postgresStorageConfig: IndySdkPostgresStorageConfig = {
  type: 'postgres_storage',
  config: {
    url: `${db_host}:${db_port}`,
    wallet_scheme: IndySdkPostgresWalletScheme.DatabasePerWallet,
  },
  credentials: {
    account: process.env.POSTGRESQL_USER || "postgres",
    password: process.env.POSTGRESQL_PASSWORD || "postgres",
    admin_account: null as any as string/*process.env.POSTGRESQL_USER || "postgres" */,
    admin_password: null as any as string/*process.env.POSTGRESQL_USER || "postgres" */
  }
}

// load the postgres wallet plugin before agent initialization
loadIndySdkPostgresPlugin(postgresStorageConfig.config, postgresStorageConfig.credentials)

const walletName = process.env.POSTGRESQL_DBNAME ? process.env.POSTGRESQL_DBNAME + "-wallet" : process.env.WALLET_NAME || 'pocket-mediator-pgdb'
logger.info(`Using PostgreSQL database ${walletName}`)

// logger.error(`PostgreSQL storage is disabled - DO NOT USE IN PROD!!!`)
const agentConfig: InitConfig = {
  endpoints,
  label: process.env.AGENT_LABEL || 'Aries Framework JavaScript Mediator',
  walletConfig: {
    id: walletName,
    key: process.env.WALLET_KEY || 'AriesFrameworkJavaScript'
  },
  autoUpdateStorageOnStartup: true,
  logger
}

// Set up agent
const agent = new Agent({
  config: agentConfig,
  dependencies: agentDependencies,
  modules: {
    indySdk: new IndySdkModule({ indySdk }),
    mediator: new MediatorModule({
      autoAcceptMediationRequests: true,
    }),
    connections: new ConnectionsModule({
      autoAcceptConnections: true,
    }),
  },
})
const config = agent.config

// Create all transports
const httpInboundTransport = new HttpInboundTransport({ app, port })
const httpOutboundTransport = new HttpOutboundTransport()
const wsInboundTransport = new WsInboundTransport({ server: socketServer })
const wsOutboundTransport = new WsOutboundTransport()

// Register all Transports
agent.registerInboundTransport(httpInboundTransport)
agent.registerOutboundTransport(httpOutboundTransport)
agent.registerInboundTransport(wsInboundTransport)
agent.registerOutboundTransport(wsOutboundTransport)

// Allow to create invitation, no other way to ask for invitation yet
httpInboundTransport.app.get('/invitation', async (req, res) => {
  logger.info("Received invitation request")
  if (typeof req.query.c_i === 'string') {
    logger.debug(`Creating invitation for received URL: ${req.url}`)
    const invitation = ConnectionInvitationMessage.fromUrl(req.url)
    const response = invitation.toJSON();
    logger.debug(`Sending invitation: ${response}`)
    res.send(response)
  } else {
    logger.debug("Creating invitation from scratch")
    const { outOfBandInvitation } = await agent.oob.createInvitation()
    const httpEndpoint = config.endpoints.find((e) => e.startsWith('http'))
    const response = outOfBandInvitation.toUrl({ domain: httpEndpoint + '/invitation' });
    logger.debug(`Sending invitation: ${response}`)
    res.send(response)
  }
})

const run = async () => {
  await agent.initialize()

  // When an 'upgrade' to WS is made on our http server, we forward the request to the WS server
  // on(event: 'upgrade', listener: (req: InstanceType<Request>, socket: stream.Duplex, head: Buffer) => void): this;
  httpInboundTransport.server?.on('upgrade', (request, socket, head) => {
    socketServer.handleUpgrade(request, socket as Socket, head, (socket) => {
      socketServer.emit('connection', socket, request)
    })
    return socketServer
  })
}

void run()
