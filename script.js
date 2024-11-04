import sqlite3InitModule from "https://esm.sh/@sqlite.org/sqlite-wasm@3.46.1-build3";
import { render, html } from "https://cdn.jsdelivr.net/npm/lit-html@3/+esm";
import { asyncLLM } from "https://cdn.jsdelivr.net/npm/asyncllm@2.1";
import { unsafeHTML } from "https://cdn.jsdelivr.net/npm/lit-html@3/directives/unsafe-html.js";
import Fuse from "https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.mjs";
import { parse } from "https://cdn.jsdelivr.net/npm/partial-json@0.1.7/+esm";
import { dsvFormat, autoType } from "https://cdn.jsdelivr.net/npm/d3-dsv@3/+esm";
import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";

const $upload = document.getElementById("upload");
const $prompt = document.getElementById("prompt");
const $schema = document.getElementById("schema");
const $filters = document.getElementById("filters");
const $pitch = document.getElementById("pitch");
const $toast = document.getElementById("toast");
const toast = new bootstrap.Toast($toast);
const $queryForm = document.getElementById("query-form");

// Initialize SQLite
const defaultDB = "@";
const sqlite3 = await sqlite3InitModule({ printErr: console.error });

const marked = new Marked();
let messages = []; // Global message queue
let metadata; // Global metadata results
let allTools = []; // Global tool results
const maxRows = 20; // Maximum number of rows to return from a tool call
let sqlarray = [];
let jsonData = [];
// let formattedResult = {};

// --------------------------------------------------------------------
// Manage database tables
const db = new sqlite3.oo1.DB(defaultDB, "c");
const DB = {
  schema: function () {
    let tables = [];
    db.exec("SELECT name, sql FROM sqlite_master WHERE type='table'", { rowMode: "object" }).forEach((table) => {
      table.columns = db.exec(`PRAGMA table_info(${table.name})`, { rowMode: "object" });
      tables.push(table);
    });
    return tables;
  },

  // Recommended questions for the current schema
  questionInfo: {},
  questions: async function () {
    if (DB.questionInfo.schema !== JSON.stringify(DB.schema())) {
      const response = await llm({
        system: "Suggest 5 diverse, useful questions that a user can answer from this dataset using SQLite",
        user: DB.schema()
          .map(({ sql }) => sql)
          .join("\n\n"),
        schema: {
          type: "object",
          properties: { questions: { type: "array", items: { type: "string" }, additionalProperties: false } },
          required: ["questions"],
          additionalProperties: false,
        },
      });
      if (response.error) DB.questionInfo.error = response.error;
      else DB.questionInfo.questions = response.questions;
      DB.questionInfo.schema = JSON.stringify(DB.schema());
    }
    return DB.questionInfo;
  },

  upload: async function (file) {
    if (file.name.match(/\.(sqlite3|sqlite|db|s3db|sl3)$/i)) await DB.uploadSQLite(file);
    else if (file.name.match(/\.csv$/i)) await DB.uploadDSV(file, ",");
    else if (file.name.match(/\.tsv$/i)) await DB.uploadDSV(file, "\t");
    else notify("danger", `Unknown file type: ${file.name}`);
  },

  uploadSQLite: async function (file) {
    const fileReader = new FileReader();
    await new Promise((resolve) => {
      fileReader.onload = async (e) => {
        await sqlite3.capi.sqlite3_js_posix_create_file(file.name, e.target.result);
        // Copy tables from the uploaded database to the default database
        const uploadDB = new sqlite3.oo1.DB(file.name, "r");
        const tables = uploadDB.exec("SELECT name, sql FROM sqlite_master WHERE type='table'", { rowMode: "object" });
        for (const { name, sql } of tables) {
          try {
            db.exec(sql);
          } catch (e) {
            console.error(e);
            notify("danger", e);
            continue;
          }
          const data = uploadDB.exec(`SELECT * FROM "${name}"`, { rowMode: "object" });
          if (data.length > 0) {
            const columns = Object.keys(data[0]);
            const sql = `INSERT INTO "${name}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns
              .map(() => "?")
              .join(", ")})`;
            const stmt = db.prepare(sql);
            db.exec("BEGIN TRANSACTION");
            for (const row of data) stmt.bind(columns.map((c) => row[c])).stepReset();
            db.exec("COMMIT");
            stmt.finalize();
          }
        }
        uploadDB.close();
        resolve();
      };
      fileReader.readAsArrayBuffer(file);
    });
  },

  uploadDSV: async function (file, separator) {
    const fileReader = new FileReader();
    const result = await new Promise((resolve) => {
      fileReader.onload = (e) => {
        const rows = dsvFormat(separator).parse(e.target.result, autoType);
        resolve(rows);
      };
      fileReader.readAsText(file);
    });
    const tableName = file.name.slice(0, -4).replace(/[^a-zA-Z0-9_]/g, "_");
    await DB.insertRows(tableName, result);
  },

  insertRows: async function (tableName, result) {
    // Create table by auto-detecting column types
    const cols = Object.keys(result[0]);
    const typeMap = Object.fromEntries(
      cols.map((col) => {
        const sampleValue = result[0][col];
        let sqlType = "TEXT";
        if (typeof sampleValue === "number") sqlType = Number.isInteger(sampleValue) ? "INTEGER" : "REAL";
        else if (typeof sampleValue === "boolean") sqlType = "INTEGER"; // SQLite has no boolean
        else if (sampleValue instanceof Date) sqlType = "TEXT"; // Store dates as TEXT
        return [col, sqlType];
      })
    );
    const createTableSQL = `CREATE TABLE IF NOT EXISTS ${tableName} (${cols
      .map((col) => `[${col}] ${typeMap[col]}`)
      .join(", ")})`;
    db.exec(createTableSQL);

    // Insert data
    const insertSQL = `INSERT INTO ${tableName} (${cols.map((col) => `[${col}]`).join(", ")}) VALUES (${cols
      .map(() => "?")
      .join(", ")})`;
    const stmt = db.prepare(insertSQL);
    db.exec("BEGIN TRANSACTION");
    for (const row of result) {
      stmt
        .bind(
          cols.map((col) => {
            const value = row[col];
            return value instanceof Date ? value.toISOString() : value;
          })
        )
        .stepReset();
    }
    db.exec("COMMIT");
    stmt.finalize();
  },
};

$upload.addEventListener("change", async (e) => {
  notify("info", "Loading", /* html */ `Importing data <div class='spinner-border spinner-border-sm'></div>`);
  const uploadPromises = Array.from(e.target.files).map((file) => DB.upload(file));
  await Promise.all(uploadPromises);
  notify("success", "Imported", `Imported all files`);
  prepareMetadata();
  drawTables();
});

// --------------------------------------------------------------------
// Render tables

async function drawTables() {
  const schema = DB.schema();

  const tables = html`
    <div class="accordion" id="table-accordion" style="--bs-accordion-btn-padding-y: 0.5rem">
      ${schema.map(
        ({ name, sql, columns }) => html`
          <div class="accordion-item">
            <h2 class="accordion-header">
              <button
                class="accordion-button collapsed"
                type="button"
                data-bs-toggle="collapse"
                data-bs-target="#collapse-${name}"
                aria-expanded="false"
                aria-controls="collapse-${name}"
              >${name}</button>
            </h2>
            <div
              id="collapse-${name}"
              class="accordion-collapse collapse"
              data-bs-parent="#table-accordion"
            >
              <div class="accordion-body">
                <pre style="white-space: pre-wrap">${sql}</pre>
                <table class="table table-striped table-sm">
                  <thead>
                    <tr>
                      <th>Column Name</th>
                      <th>Type</th>
                      <th>Not Null</th>
                      <th>Default Value</th>
                      <th>Primary Key</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${columns.map(
                      (column) => html`
                        <tr>
                          <td>${column.name}</td>
                          <td>${column.type}</td>
                          <td>${column.notnull ? "Yes" : "No"}</td>
                          <td>${column.dflt_value ?? "NULL"}</td>
                          <td>${column.pk ? "Yes" : "No"}</td>
                        </tr>
                      `
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      `
      )}
    </div>
  `;
  render([tables], $schema);
}

function notify(cls, title, message) {
  $toast.querySelector(".toast-title").textContent = title;
  $toast.querySelector(".toast-body").innerHTML = message;
  const $toastHeader = $toast.querySelector(".toast-header");
  $toastHeader.classList.remove("text-bg-success", "text-bg-danger", "text-bg-warning", "text-bg-info");
  $toastHeader.classList.add(`text-bg-${cls}`);
  toast.show();
}

// --------------------------------------------------------------------
// Query form

$queryForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const data = new FormData($queryForm);
  let schema = DB.schema();
  if (!schema.length) await autoload();
  schema = DB.schema();
  schema = schema.map(({ sql }) => sql).join("\n\n");

  const currentMessages = [
    { role: "system", content: data.get("prompt").replace("$SCHEMA", schema) },
    { role: "user", content: data.get("q") },
  ];
  messages.splice(0, 2, ...currentMessages);

  const toolArgs = (name, args) =>
    name == "sql" ? args.query : name == "similar" ? html`${args.table}.${args.column} ~ ${args.input}` : "";

  let content, tools;
  for await ({ content, tools } of asyncLLM("https://llmfoundry.straive.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      model: "gpt-4o-mini",
      stream: true,
      messages,
      // tool_choice: "required",
      tools: [
        {
          type: "function",
          function: {
            name: "sql",
            description: "Run an SQL query. Return { count: number, results: [{}, ...] }",
            parameters: {
              type: "object",
              properties: { query: { type: "string", description: "The SQL query to run." } },
              required: ["query"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "similar",
            description: "Get the most similar values to a given input from a table's column. Return [value, ...]",
            parameters: {
              type: "object",
              properties: {
                table: { type: "string", description: "The table to search in." },
                column: { type: "string", description: "The column to search in." },
                input: { type: "string", description: "The input to search for." },
              },
              required: ["table", "column", "input"],
            },
          },
        },
      ],
    }),
  })) {
    if (tools) {
      render(
        html`<table class="table table-striped table-sm">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Arguments</th>
            </tr>
          </thead>
          <tbody>
            ${tools.map(({ name, args }) => {
              if (!args) return null;
              return html`<tr>
                <td>${name}</td>
                <td>${toolArgs(name, args)}</td>
              </tr>`;
            })}
          </tbody>
        </table>`,
        $filters
      );
    }
  }
  if (content) render(unsafeHTML(marked.parse(content)), $pitch);

  // Add the tool calls to the messages
  const tool_calls = tools.map(({ id, name, args }) => ({ id, type: "function", function: { name, arguments: args } }));
  messages.push({ role: "assistant", tool_calls });

  // Execute the tool calls
  for (const tool of tools) {
    tool.args = parse(tool.args);
    if (tool.name == "sql") {
      try {
        tool.result = db.exec(tool.args.query, { rowMode: "object" }).slice(0, maxRows);
      } catch (e) {
        tool.result = { error: e.message };
      }
    } else if (tool.name == "similar") {
      const { table, column, input } = tool.args;
      try {
        tool.result = db
          .exec(`SELECT DISTINCT ${column} FROM ${table} WHERE ${column} LIKE ?`, {
            bind: [`%${input}%`],
            rowMode: "object",
          })
          .slice(0, maxRows);
      } catch (e) {
        tool.result = { error: e.message };
      }
    }
    jsonData.push({ toolName: tool.name, args: tool.args, result: tool.result });
    allTools.push(tool);
    console.log(allTools);
    messages.push({ role: "tool", tool_call_id: tool.id, content: JSON.stringify(tool.result) });
  }
    // Convert jsonData to JSON format and save it
  const jsonString = JSON.stringify(jsonData, null, 2);
  console.log("JSON string:", typeof(jsonString));
  console.log("JSON data:", jsonData);
  console.log("Json type", typeof(jsonData));

  render(
    html`<table class="table table-striped table-sm">
      <thead>
        <tr>
          <th>Tool</th>
          <th>Arguments</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        ${allTools.toReversed().map(
          ({ name, args, result }) =>
            html`<tr>
              <td>${name}</td>
              <td>${toolArgs(name, args)}</td>
              <td>${JSON.stringify(result)}</td>
            </tr>`
        )}
      </tbody>
    </table>`,
    $filters
  );
  getWhereCondition(allTools);
  renderSentencesInCard(sqlarray,jsonData);
});

// --------------------------------------------------------------------
function prepareMetadata() {
  metadata = { table: db.exec("SELECT * FROM metadata", { rowMode: "object" }) };
  if (!metadata.table.length) return;
  const fields = metadata.table.filter(
    ({ category }) => category == "embedding" || category == "enum" || category == "string-diff"
  );
  const tables = [...new Set(fields.map(({ table }) => table))];
  metadata.fuse = {};
  for (const table of tables) {
    const tableFields = fields.filter(({ table: ftable }) => ftable == table);
    // TODO
    // metadata.fuse[table] = new Fuse(db.exec("SELECT *"), { keys: ["column"] });
  }
  console.log(metadata);
}

function saveFormState($form, formKey) {
  // When the page loads, restore the form state from localStorage
  for (const [key, value] of Object.entries(JSON.parse(localStorage[formKey] || "{}"))) {
    const input = $form.querySelector(`[name="${key}"]`);
    if (!input) continue;
    if (input.matches("textarea, select, input[type=range], input[type=text]")) input.value = value;
    else if (input.matches("input[type=checkbox]")) input.checked = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // When form is changed, save the form state to localStorage
  $form.addEventListener(
    "input",
    () => (localStorage[formKey] = JSON.stringify(Object.fromEntries(new FormData($form))))
  );
  // When form is reset, also clear localStorage
  $form.addEventListener("reset", () => (localStorage[formKey] = "{}"));
}

saveFormState($queryForm, "cocoagpt");

async function autoload() {
  notify("info", "Loading", /* html */ `Loading default datasets <div class='spinner-border spinner-border-sm'></div>`);

  try {
    // Fetch the SQLite database
    const dbResponse = await fetch("barry-callebout-data.db");
    const dbBlob = await dbResponse.blob();
    const dbFile = new File([dbBlob], "barry-callebout-data.db");

    // Fetch the CSV file
    const csvResponse = await fetch("metadata.csv");
    const csvBlob = await csvResponse.blob();
    const csvFile = new File([csvBlob], "metadata.csv");

    // Upload both files using existing DB methods
    await Promise.all([DB.upload(dbFile), DB.upload(csvFile)]);

    notify("success", "Loaded", "Default datasets imported successfully");

    prepareMetadata();
    drawTables();
  } catch (error) {
    console.error(error);
    notify("danger", "Error", "Failed to load default datasets");
  }
}
function getWhereCondition(arr) {
  arr.forEach(element => {
    if (element.name === "sql") {
      let q = element.args["query"];
      let whereMatch = q.match(/\bWHERE\b\s+([^\s]+)(?=\s+\b(?:AND|OR|GROUP|ORDER|HAVING|LIMIT|$))/i);
      // Only add the match if it exists and is not already in sqlarray
      if (whereMatch && whereMatch[1]) {
        let condition = whereMatch[1].trim();
        if (!sqlarray.includes(condition)) {
          sqlarray.push(condition);
        }
      }
    }
  });
  console.log("output",sqlarray);
}
function renderSentencesInCard(sentences, jsonData) {
  // Ensure that sentences array exists and is not empty before continuing
  if (Array.isArray(sentences) && sentences.length > 0) {
    document.getElementById("wherefilter").classList.remove("d-none");
    // Function to extract column names and corresponding unique values based on the sentence and jsonData
    function extractValuesBySummary(jsonData) {
      let formattedResult = {};  // Initialize the formattedResult object
      jsonData.forEach(item => {
        // Check if toolName is 'sql' and result array has items
        if (item.toolName === "sql" && item.result.length >= 0) {
          item.result.forEach(entry => {
            for (const [key, value] of Object.entries(entry)) {
              // If the key doesn't exist in formattedResult, initialize it as an array
              if (!formattedResult[key]) {
                formattedResult[key] = [];
              }
              // Only add unique values to the array for each key
              if (!formattedResult[key].includes(value)) {
                formattedResult[key].push(value);
              }
            }
          });
        }
      });
      // Filter the formattedResult to include only the keys present in sentences
      let filteredResult = {};
      sentences.forEach(sentence => {
        if (formattedResult[sentence]) {
          filteredResult[sentence] = formattedResult[sentence];
        }else{filteredResult[sentence] = []}
      });
      return filteredResult;
    }
    let keyvalues = extractValuesBySummary(jsonData);
    console.log("Filtered keyvalues:", keyvalues);
    // Function to create dropdowns and values
    const createSelectDropdown = (key, values) => html`
      <div class="form-group">
      <label for="${key}-select" class="my-2">${key}</label>
      <select id="${key}-select" class="form-control">
        ${Array.isArray(values) && values.length > 0
          ? values.map(value => html`<option value="${value}">${value}</option>`)
          : html`<option value="">No values found!</option>`
        }
      </select>
    </div>
    `;
    // Render function for the card
    const renderCard = () => html`
      <div>
        ${Object.entries(keyvalues).map(([key, values]) => createSelectDropdown(key, values))}
      </div>
    `;
    // Render the card in the element with id "card"
    render(renderCard(), document.getElementById('wherefilter'));
  } else {
    console.log("No sentences provided to render.");
  }
}
autoload();
