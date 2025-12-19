#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Database, aql } from "arangojs";
import { z } from "zod";

function printUsageAndExit(exitCode: 0 | 1): never {
  const usage = [
    "Usage:",
    "  arangodb-mcp-server [--enable-write] <url> [username] [password]",
    "",
    "Arguments:",
    "  url       ArangoDB base URL (e.g. http://localhost:8529)",
    "  username  Optional username",
    "  password  Optional password",
    "",
    "Flags:",
    "  --enable-write  Expose and allow the readWriteQuery tool",
    "  --help          Show this help",
  ].join("\n");

  // MCP servers typically log to stderr.
  console.error(usage);
  process.exit(exitCode);
}

const KNOWN_FLAGS = new Set(["--enable-write", "--help"]);

const rawArgs = process.argv.slice(2);
const flags = new Set<string>();
const positionals: string[] = [];

for (const arg of rawArgs) {
  if (arg.startsWith("--")) {
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`Unknown flag: ${arg}`);
      printUsageAndExit(1);
    }
    flags.add(arg);
  } else {
    positionals.push(arg);
  }
}

if (flags.has("--help")) {
  printUsageAndExit(0);
}

const enableWrite = flags.has("--enable-write");

if (positionals.length < 1) {
  console.error("Please provide a database URL");
  printUsageAndExit(1);
}

// Database URL should be in the format:
// "http://localhost:8529"
const databaseUrl = positionals[0];

const username = positionals.length > 1 ? positionals[1] : undefined;
const password = positionals.length > 2 ? positionals[2] : undefined;

const auth = username && password ? { username, password } : undefined;

const db = new Database({
  url: databaseUrl,
  auth: auth,
});

// Create the McpServer instance
const server = new McpServer(
  {
    name: "arangodb-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      logging: {},
      resources: {},
      tools: {},
    },
  }
);

function debug(data: string) {
  server.server.sendLoggingMessage({
    level: "debug",
    data: data,
  });
}

function error(data: string) {
  server.server.sendLoggingMessage({
    level: "error",
    data: data,
  });
}

// Collection schema for parsing
const collectionSchema = z
  .object({
    _id: z.string(),
    name: z.string(),
  })
  .strict();

type CollectionType = z.infer<typeof collectionSchema>;

// Database connection pool
const databaseConnections = new Map<string, Database>();

function getOrCreateDatabaseConnection(databaseName: string): Database {
  if (databaseConnections.has(databaseName)) {
    return databaseConnections.get(databaseName)!;
  }

  const dbConnector = new Database({
    url: databaseUrl,
    databaseName: databaseName,
    auth: auth,
  });

  databaseConnections.set(databaseName, dbConnector);
  return dbConnector;
}

async function getCollections(db: Database): Promise<CollectionType[]> {
  const cursor = await db.query(aql`
    FOR collection IN COLLECTIONS()
    FILTER !STARTS_WITH(collection.name, "_")
    RETURN {
      _id: collection._id,
      name: collection.name
    }
  `);

  const result = await cursor.all();
  const allCollections: Array<CollectionType> = [];

  for (const collection of result) {
    allCollections.push(collectionSchema.parse(collection));
  }

  return allCollections;
}

// ============================================
// URI Parsing for Resources
// ============================================

interface ArangoDBCollectionURI {
  type: "collection";
  databaseName: string;
  collectionName: string;
}

interface ArangoDBDocumentURI {
  type: "document";
  databaseName: string;
  collectionName: string;
  documentId: string;
}

type ArangoDBURI = ArangoDBCollectionURI | ArangoDBDocumentURI;

class InvalidArangoDBURIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArangoDBURIError";
  }
}

/**
 * Parses and validates an ArangoDB URI string of the format:
 * - arangodb:///databaseName/collectionName (collection)
 * - arangodb:///databaseName/collectionName/documentID (document)
 *
 * @param uri The ArangoDB URI string to parse
 * @returns An object containing the parsed components
 * @throws InvalidArangoDBURIError if the URI format is invalid
 */
export function parseArangoDBURI(uri: string): ArangoDBURI {
  // Check if the string starts with the correct prefix
  if (!uri.startsWith("arangodb:///")) {
    throw new InvalidArangoDBURIError('URI must start with "arangodb:///"');
  }

  // Remove the prefix and split the remaining path
  const path = uri.slice("arangodb:///".length);
  const components = path.split("/");

  // Validate we have 2 or 3 components
  if (components.length < 2 || components.length > 3) {
    throw new InvalidArangoDBURIError(
      "URI must have 2 or 3 components: databaseName/collectionName[/documentId]"
    );
  }

  const [databaseName, collectionName, documentId] = components;

  if (!databaseName) {
    throw new InvalidArangoDBURIError("Database name cannot be empty");
  }

  if (!collectionName) {
    throw new InvalidArangoDBURIError("Collection name cannot be empty");
  }

  if (components.length === 2) {
    return {
      type: "collection",
      databaseName,
      collectionName,
    };
  }

  if (!documentId) {
    throw new InvalidArangoDBURIError("Document ID cannot be empty");
  }

  return {
    type: "document",
    databaseName,
    collectionName,
    documentId,
  };
}

// ============================================
// Resource Templates Registration
// ============================================

// Collection resource template
server.registerResource(
  "ArangoDB collection",
  new ResourceTemplate("arangodb:///{database}/{collection}", {
    list: async () => {
      debug(`Listing all collections across databases`);

      const allDatabases = await db.databases();
      const userDatabases = allDatabases.filter(d => d.name !== "_system");

      const collectionsPerDb = await Promise.all(
        userDatabases.map(async (database) => {
          const dbConnection = getOrCreateDatabaseConnection(database.name);
          const collections = await getCollections(dbConnection);
          return { database, collections };
        })
      );

      const resources = collectionsPerDb.flatMap(({ database, collections }) =>
        collections.map((collection) => ({
          uri: `arangodb:///${database.name}/${collection.name}`,
          mimeType: "application/json",
          name: `${database.name}/${collection.name}`,
          description: `Collection "${collection.name}" in database "${database.name}"`,
        }))
      );

      return { resources };
    },
  }),
  {
    mimeType: "application/json",
    description: "A collection in an ArangoDB database with document count and sample documents",
  },
  async (uri, variables) => {
    const database = variables.database as string;
    const collection = variables.collection as string;

    debug(`Reading collection resource: ${database}/${collection}`);

    const dbConnection = getOrCreateDatabaseConnection(database);
    const collectionHandle = dbConnection.collection(collection);

    const [countResult, cursor] = await Promise.all([
      collectionHandle.count(),
      dbConnection.query(aql`
        FOR doc IN ${collectionHandle}
        LIMIT 10
        RETURN doc
      `),
    ]);
    const sampleDocs = await cursor.all();

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            collection: collection,
            database: database,
            documentCount: countResult.count,
            sampleDocuments: sampleDocs,
          }, null, 2),
        },
      ],
    };
  }
);

// Document resource template
server.registerResource(
  "ArangoDB document",
  new ResourceTemplate("arangodb:///{database}/{collection}/{documentID}", {
    list: undefined, // Documents are accessed directly, not listed
  }),
  {
    mimeType: "application/json",
    description: "A document in an ArangoDB collection",
  },
  async (uri, variables) => {
    const database = variables.database as string;
    const collection = variables.collection as string;
    const documentID = variables.documentID as string;

    debug(`Reading document resource: ${database}/${collection}/${documentID}`);

    const dbConnection = getOrCreateDatabaseConnection(database);

    try {
      const document = await dbConnection
        .collection(collection)
        .document(documentID);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(document, null, 2),
          },
        ],
      };
    } catch (err) {
      error(`Error reading document ${uri.href}: ${err}`);
      throw err;
    }
  }
);

// ============================================
// Tools Registration
// ============================================

// readQuery tool
server.registerTool(
  "readQuery",
  {
    description: "Run a read-only AQL query",
    inputSchema: {
      databaseName: z.string().describe("The database to query"),
      aql: z.string().describe("The read-only AQL query to execute"),
    },
  },
  async ({ databaseName, aql: aqlQuery }) => {
    debug(`readQuery on ${databaseName}: ${aqlQuery}`);

    const dbConnector = getOrCreateDatabaseConnection(databaseName);
    const cursor = await dbConnector.query(aqlQuery);
    const result = await cursor.all();

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// readWriteQuery tool (conditionally registered)
if (enableWrite) {
  server.registerTool(
    "readWriteQuery",
    {
      description: "Run an AQL query (including writes)",
      inputSchema: {
        databaseName: z.string().describe("The database to query"),
        aql: z.string().describe("The AQL query to execute"),
      },
    },
    async ({ databaseName, aql: aqlQuery }) => {
      debug(`readWriteQuery on ${databaseName}: ${aqlQuery}`);

      const dbConnector = getOrCreateDatabaseConnection(databaseName);
      const cursor = await dbConnector.query(aqlQuery);
      const result = await cursor.all();

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

// listDatabases tool
server.registerTool(
  "listDatabases",
  {
    description: "List all the databases",
  },
  async () => {
    debug("listDatabases");

    const allDatabases = await db.databases();

    return {
      content: [{
        type: "text",
        text: JSON.stringify(allDatabases.map(database => ({
          name: database.name,
        })), null, 2)
      }],
    };
  }
);

// listCollections tool
server.registerTool(
  "listCollections",
  {
    description: "List all the collections in a database",
    inputSchema: {
      databaseName: z.string().describe("The name of the database"),
    },
  },
  async ({ databaseName }) => {
    debug(`listCollections for ${databaseName}`);

    const dbConnector = getOrCreateDatabaseConnection(databaseName);
    const allCollections = await getCollections(dbConnector);

    return {
      content: [{
        type: "text",
        text: JSON.stringify(allCollections.map(collection => ({
          name: collection.name
        })), null, 2)
      }],
    };
  }
);

// ============================================
// Server Startup
// ============================================

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);
