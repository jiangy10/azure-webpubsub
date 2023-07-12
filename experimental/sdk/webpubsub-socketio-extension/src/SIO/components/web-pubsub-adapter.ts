// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { debugModule, toString } from "../../common/utils";
import { WebPubSubServiceClient, HubSendTextToAllOptions } from "@azure/web-pubsub";
import { getSingleEioEncodedPayload } from "./encoder";
import { Packet as SioPacket, PacketType as SioPacketType } from "socket.io-parser";
import { Namespace, Server as SioServer } from "socket.io";
import { Adapter as NativeInMemoryAdapter, BroadcastOptions, Room, SocketId } from "socket.io-adapter";
import { Mutex, MutexInterface } from "async-mutex";
import base64url from "base64url";

const debug = debugModule("wps-sio-ext:SIO:Adapter");

const GROUP_DELIMITER = "~";
const NotImplementedError = new Error("Not Implemented. This feature will be available in further version.");
const NotSupportedError = new Error("Not Supported.");
const NonLocalNotSupported = new Error("Non-local condition is not Supported.");

/**
 * Socket.IO Server uses method `io.Adapter(AdapterClass))` to set the adapter. `AdatperClass` is not an instansized object, but a class.
 * The actual adapter is instansized inside server logic.
 * Thus its constructor parameters of the adapter class is out of our control.
 * So a proxy class is necessary to wrap the adapter class for customimzed constructor parameters.
 * How to use:
 *  1. Instansize a `WebPubSubAdapterProxy` object: `const webPubSubAdapterProxy = new WebPubSubAdapterProxy(extraOptions);`
 *  2. Set the adapter: `io.adapter(WebPubSubAdapterProxy);`, thus additional options are controllable.
 */
export class WebPubSubAdapterProxy {
  public serivce: WebPubSubServiceClient;
  public sioServer: SioServer;

  constructor(serviceClient: WebPubSubServiceClient) {
    this.serivce = serviceClient;

    const proxyHandler = {
      construct: (target, args) => new target(...args, serviceClient),
    };
    return new Proxy(WebPubSubAdapterInternal, proxyHandler);
  }
}

export class WebPubSubAdapterInternal extends NativeInMemoryAdapter {
  public service: WebPubSubServiceClient;
  private _roomOperationLock: Map<SocketId, Mutex> = new Map();

  /**
   * Azure Web PubSub Socket.IO Adapter constructor.
   *
   * @param nsp - Namespace
   * @param extraArgForWpsAdapter - extra argument for WebPubSubAdapter
   */
  constructor(readonly nsp: Namespace, serviceClient: WebPubSubServiceClient) {
    debug(`constructor nsp.name = ${nsp.name}, serviceClient = ${serviceClient}`);
    super(nsp);
    this.service = serviceClient;
  }

  /**
   * Broadcasts a packet.
   *
   * @param packet - the packet object
   * @param opts - the options
   */
  public override async broadcast(packet: SioPacket, opts: BroadcastOptions): Promise<void> {
    debug(`broadcast, start, packet = ${JSON.stringify(packet)}, opts = ${JSON.stringify(opts)}`);
    packet.nsp = this.nsp.name;

    const encodedPayload = await getSingleEioEncodedPayload(packet);

    const oDataFilter = this._buildODataFilter(opts.rooms, opts.except);
    const sendOptions = { filter: oDataFilter, contentType: "text/plain" };
    debug(`broadcast, encodedPayload = "${encodedPayload}", sendOptions = "${JSON.stringify(sendOptions)}"`);

    await this.service.sendToAll(encodedPayload, sendOptions as HubSendTextToAllOptions);
    debug(`broadcast, finish`);
  }

  /**
   * Makes the matching socket instances join the specified rooms
   *
   * @param opts - the filters to apply
   * @param rooms - the rooms to join
   */
  public addSockets(opts: BroadcastOptions, rooms: Room[]): void {
    throw NotImplementedError;
  }

  /**
   * Adds a socket to a list of room.
   *
   * @param id - the socket id
   * @param rooms - a set of rooms
   */
  public async addAll(id: SocketId, rooms: Set<Room>): Promise<void> {
    // TODO: RT should support a new API AddConnectionsToGroups
    debug(`addAll, start, id = ${id}, rooms = ${toString(rooms)}}`);
    const release = await this._getLock(id);
    try {
      const eioSid = this._getEioSid(id);
      for (const room of rooms) {
        const groupName = this._getGroupName(this.nsp.name, room);
        await this.service.group(groupName).addConnection(eioSid);
        debug(
          `addAll, call API AddConnectionToGroup, finish, groupName = ${groupName}, connectionId(eioSid) = ${eioSid}`
        );
      }
      super.addAll(id, rooms);
    } catch (e) {
      debug(`addAll, error, SocketId = ${id}, rooms = ${toString(rooms)}, error.message = ${e.message}`);
    } finally {
      release();
    }
    debug(`addAll, finish, SocketId = ${id}, rooms = ${toString(rooms)}, id.rooms = ${toString(this.sids.get(id))}`);
  }

  /**
   * Removes a socket from a room.
   *
   * @param id - the socket id
   * @param room - the room name
   */
  public async del(id: SocketId, room: Room): Promise<void> {
    debug(`del, start, id = ${id}, room = ${room}`);
    const release = await this._getLock(id);
    try {
      const eioSid = this._getEioSid(id);
      const groupName = this._getGroupName(this.nsp.name, room);

      await this.service.group(groupName).removeConnection(eioSid);

      debug(
        `del, call API RemoveConnectionFromGroup, finish, groupName = ${groupName}, connectionId(eioSid) = ${eioSid}`
      );
      super.del(id, room);
    } catch (e) {
      debug(`del, error, SocketId = ${id}, room = ${room}, error.message = ${e.message}`);
    } finally {
      release();
    }
    debug(`del, finish, SocketId = ${id}, room = ${room}, id.rooms = ${toString(this.sids.get(id))}`);
  }

  /**
   * Removes a socket from all rooms it's joined.
   *
   * @param id - the socket id
   */
  public async delAll(id: SocketId): Promise<void> {
    debug(`delAll, start, id = ${id}`);
    const release = await this._getLock(id);
    debug(`delAll, lock acquired`);
    try {
      // send disconnect packet to socketio connection by leveraging private room whose name == sid
      const packet: SioPacket = { type: SioPacketType.DISCONNECT } as SioPacket;
      const opts: BroadcastOptions = { rooms: new Set([id]) } as BroadcastOptions;
      debug(`delAll, call adapter.broadcast`);

      await this.broadcast(packet, opts);

      super.delAll(id);
    } catch (e) {
      debug(`delAll, error, SocketId = ${id}, error.message = ${e.message}`);
    } finally {
      release();
    }
    debug(`delAll, finish, SocketId = ${id}, id.rooms = ${toString(this.sids.get(id))}`);
  }

  /**
   * Broadcasts a packet and expects multiple acknowledgements.
   *
   * @param packet - the packet object
   * @param opts - the options
   * @param clientCountCallback - the number of clients that received the packet
   * @param ack - the callback that will be called for each client response
   */
  public broadcastWithAck(
    packet: SioPacket,
    opts: BroadcastOptions,
    clientCountCallback: (clientCount: number) => void,
    ack: (...args: unknown[]) => void
  ): void {
    throw NotImplementedError;
  }

  /**
   * Gets a list of sockets by sid.
   *
   * @param rooms - the explicit set of rooms to check.
   */
  public sockets(rooms: Set<Room>): Promise<Set<SocketId>> {
    throw NotSupportedError;
  }

  /**
   * Gets the list of rooms a given socket has joined.
   *
   * @param id - the socket id
   */
  public socketRooms(id: SocketId): Set<Room> | undefined {
    debug(`socketRooms, start, id = ${id}`);
    // Follow the same handling logic as RedisAdapter. Though it's incorrect strictly for multiple server condition.
    const ret = super.socketRooms(id);
    debug(`socketRooms, finish, id = ${id} ${toString(ret)}`);
    return ret;
  }

  /**
   * Returns the matching socket instances
   *
   * @param opts - the filters to apply
   */
  public fetchSockets(opts: BroadcastOptions): Promise<unknown[]> {
    debug(`fetchSockets, start, opts = ${JSON.stringify(opts)}`);
    if (opts.flags.local) {
      return super.fetchSockets(opts);
    } else {
      throw NotSupportedError;
    }
  }

  /**
   * Makes the matching socket instances leave the specified rooms
   *
   * @param opts - the filters to apply
   * @param rooms - the rooms to leave
   */
  public delSockets(opts: BroadcastOptions, rooms: Room[]): void {
    throw NotImplementedError;
  }

  /**
   * Send a packet to the other Socket.IO servers in the cluster
   * @param packet - an array of arguments, which may include an acknowledgement callback at the end
   */
  public override serverSideEmit(packet: unknown[]): void {
    throw NotSupportedError;
  }

  /**
   * Makes the matching socket instances disconnect
   *
   * @param opts - the filters to apply
   * @param close - whether to close the underlying connection
   */
  public async disconnectSockets(opts: BroadcastOptions, close: boolean): Promise<void> {
    debug(`disconnectSockets, start, opts = ${JSON.stringify(opts)}, close = ${close}`);
    await this.broadcast({ type: SioPacketType.DISCONNECT, nsp: this.nsp.name, data: { close } } as SioPacket, opts);
    debug(`disconnectSockets, finish, opts = ${JSON.stringify(opts)}, close = ${close}`);
  }

  /**
   * Generates OData filter string for Web PubSub service from a set of rooms and a set of exceptions
   * @param rooms - a set of Rooms to include
   * @param except - a set of Rooms to exclude
   * @returns OData - filter string
   */
  private _buildODataFilter(rooms: Set<string>, excepts: Set<string> | undefined): string {
    debug("_buildODataFilter");
    let allowFilter = "";
    let room_idx = 0,
      except_idx = 0;

    if (rooms.size === 0) rooms = new Set([""]);
    for (const room of rooms) {
      const groupName = this._getGroupName(this.nsp.name, room);
      allowFilter += `'${groupName}' in groups` + (room_idx === rooms.size - 1 ? "" : " or ");
      room_idx++;
    }

    let denyFilter = "";
    if (excepts) {
      for (const except of excepts) {
        const exceptGroupName = this._getGroupName(this.nsp.name, except);
        denyFilter += `not ('${exceptGroupName}' in groups)` + (except_idx === excepts.size - 1 ? "" : " and ");
        except_idx++;
      }
    }

    let result = "";
    if (allowFilter.length > 0) {
      result = allowFilter + (denyFilter.length > 0 ? " and " + denyFilter : "");
    } else result = denyFilter.length > 0 ? `${denyFilter}` : "";
    debug(`_buildODataFilter result = ${result}`);
    return result;
  }

  private _getEioSid(sioSid: string): string {
    debug(`Get EIO socket, id = "${sioSid}", nsp.sockets = ${toString(this.nsp.sockets.keys())}`);
    return this.nsp.sockets.get(sioSid).conn["id"];
  }

  /**
   * `namespace` and `room` are concpets from Socket.IO.
   * `group` is a concept from Azure Web PubSub.
   */
  private _getGroupName(namespace: string, room?: string): string {
    let ret = `0${GROUP_DELIMITER}${base64url(namespace)}${GROUP_DELIMITER}`;
    if (room && room.length > 0) {
      ret += base64url(room);
    }
    debug(`convert (ns="${namespace}", room="${room}") => groupName = "${ret}"`);
    return ret;
  }

  private async _getLock(id: SocketId): Promise<MutexInterface.Releaser> {
    debug(`_getLock, start, id = ${id}`);

    if (!this._roomOperationLock.has(id)) {
      this._roomOperationLock.set(id, new Mutex());
    }
    const lock = this._roomOperationLock.get(id);
    const release = await lock.acquire();

    debug(`_getLock, finish, id = ${id}`);
    return release;
  }
}