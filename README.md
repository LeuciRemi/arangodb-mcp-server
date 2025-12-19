# ArangoDB MCP Server

This is an implementation of the Model Context Protocol for ArangoDB.

## Overview

To be filled.

## Components

### Resources

### Tools

#### Query Tools

- `readQuery`
  - Execute read-only query on the database
  - Input:
    - `databaseName` (string): The database to query
    - `aql` (string): The read-only AQL query to execute
  - Returns: Query results as array of objects
- `readWriteQuery` (opt-in)
  - Execute query on the database (including writes)
  - Disabled by default; enable it by starting the server with `--enable-write`
  - Input:
    - `databaseName` (string): The database to query
    - `aql` (string): The AQL query to execute
  - Returns: Query results as array of objects
- `listDatabases`
  - List all the databases on the ArangoDB server
  - Returns: Array of the databases names
- `listCollections`
  - List all the collections in an ArangoDB database
  - Input:
    - `databaseName` (string): The name of the database
  - Returns: Array of objects `{ "name": "<collectionName>" }`

## Security

By default, the `readWriteQuery` tool is **disabled** to prevent accidental data modifications. Only enable it with `--enable-write` when write operations are explicitly needed.

## Usage

To connect to an arangodb instance running on localhost:8529, add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "arangodb-account": {
      "command": "npx",
      "args": [
        "-y",
        "arango-mcp-server",
        "http://localhost:8529",
        "root",
        "root"
      ]
    }
  }
}
```

To enable write queries, add the `--enable-write` flag:

```json
{
  "mcpServers": {
    "arangodb-account": {
      "command": "npx",
      "args": [
        "-y",
        "arango-mcp-server",
        "--enable-write",
        "http://localhost:8529",
        "root",
        "root"
      ]
    }
  }
}
```

## Development

Clone the repository.
Install everything.
Setup the dev environment.
Run the watcher.
Edit index.ts.

```sh
$ npm install
$ npm run dev:setup
$ npm run dev
```

Go to http://localhost:5173/ to see the inspector.

## Todo

- [ ] Properly study the spec to see if the current implementation of resources actually make sense (I don't think it does)
  - [x] The resource templates make sense
- [ ] Change all the "arango" to "arangodb" (repo name included...)
- [ ] Add back the arangodb password
- [ ] Proper README
  - [ ] Tools/resource/etc following the format of the official anthropic stuff
- [ ] Figure out notifications
- [ ] Health checks
- [ ] More tools?
- [ ] Access all the databases running on an arangodb instance
- [ ] Release on npm somehow so it can be used with `npx`
- [ ] `resources/subscribe` and `notifications/resources/list_changed` and `resources/unsubscribe`
- [x] Properly document tools in the readme
- [x] Like on the SQLite MCP client
  - [x] `write_query` tool separated from `read_query` -> actually is `readWriteQuery`
  - [x] `list_collections` (see `list_tables`)
- [x] Client pool ie one client per database
- [x] Dev environment
- [x] `resources/read` with a template to read any document by database name, collection, id.
- [x] Add username and passwords as parameters of the command
