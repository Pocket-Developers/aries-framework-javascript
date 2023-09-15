import type {
  Agent,
  InboundTransport,
  Logger,
  TransportSession,
  EncryptedMessage,
  AgentContext,
} from '@aries-framework/core'

import { AriesFrameworkError, TransportService, utils, MessageReceiver } from '@aries-framework/core'
import WebSocket, { Server } from 'ws'

export class WsInboundTransport implements InboundTransport {
  private socketServer: Server
  private logger!: Logger

  // We're using a `socketId` just for the prevention of calling the connection handler twice.
  private socketIds: Record<string, unknown> = {}

  public constructor({ server, port }: { server: Server; port?: undefined } | { server?: undefined; port: number }) {
    this.socketServer = server ?? new Server({ port })
  }

  public async start(agent: Agent) {
    const transportService = agent.dependencyManager.resolve(TransportService)

    this.logger = agent.config.logger

    const wsEndpoint = agent.config.endpoints.find((e) => e.startsWith('ws'))
    this.logger.debug(`Starting WS inbound transport`, {
      endpoint: wsEndpoint,
    })

    this.socketServer.on('connection', (socket: WebSocket) => {
      const socketId = utils.uuid()
      this.logger.debug('Socket connected.')

      if (!this.socketIds[socketId]) {
        this.logger.debug(`Saving new socket with id ${socketId}.`)
        this.socketIds[socketId] = socket
        const session = new WebSocketTransportSession(socketId, socket, this.logger)
        this.listenOnWebSocketMessages(agent, socket, session)
        socket.on('close', () => {
          this.logger.debug('Socket closed.')
          transportService.removeSession(session)
        })
      } else {
        this.logger.debug(`Socket with id ${socketId} already exists.`)
      }
    })
  }

  public async stop() {
    this.logger.debug('Closing WebSocket Server')

    return new Promise<void>((resolve, reject) => {
      this.socketServer.close((error) => {
        if (error) {
          reject(error)
        }
        resolve()
      })
    })
  }

  private listenOnWebSocketMessages(agent: Agent, socket: WebSocket, session: TransportSession) {
    const messageReceiver = agent.dependencyManager.resolve(MessageReceiver)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socket.addEventListener('message', async (event: any) => {
      this.logger.debug('WebSocket message event received.', { url: event.target.url })
      try {
        await messageReceiver.receiveMessage(JSON.parse(event.data), { session })
      } catch (error) {
        this.logger.error('Error processing message: ' + error)
      }
    })
  }
}

export class WebSocketTransportSession implements TransportSession {
  public id: string
  public readonly type = 'WebSocket'
  public socket: WebSocket
  private logger!: Logger

  public constructor(id: string, socket: WebSocket, logger: Logger) {
    this.id = id
    this.socket = socket
    this.logger = logger
  }

  public async send(agentContext: AgentContext, encryptedMessage: EncryptedMessage): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new AriesFrameworkError(`${this.type} transport session has been closed.`)
    }
    // websockets get closed by infrastructure after a given timeout (typically 60s)
    // this is expected and desirable, otherwise the number of opened web sockets could become unmanageable
    // but when a mobile app becomes inactive, it stops processing websocket messages until it becomes active again
    // as a result, messages sent whilst the app is inactive are irremediably lost when the websocket is closed
    // in order to minimize the risk of message loss, we do a ping/pong and only send the message when the pong is received
    let success = false;
    let timeoutId: any | null = null;
    const delay = (ms: number, val: any) => new Promise( (resolve) => { timeoutId = setTimeout( resolve, ms ) })
    this.socket.once("pong", () => {
      this.socket.send(JSON.stringify(encryptedMessage), (error?) => {
        if (error != undefined) {
          this.logger.error('Error sending message: ' + error)
          throw new AriesFrameworkError(`${this.type} send message failed.`)
        } else {
          this.logger.debug(`${this.type} sent message successfully.`)
          success = true;
          clearTimeout(timeoutId)
        }
      })
    })
    this.socket.ping("ping")
    await delay(10000, () => success = false)
    if(!success) {
        this.logger.error('Error pinging endpoint')
        throw new AriesFrameworkError(`${this.type} send message failed.`)
    }
  }

  public async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.close()
    }
  }
}
