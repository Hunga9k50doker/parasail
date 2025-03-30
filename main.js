const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const { HttpsProxyAgent } = require("https-proxy-agent");
const readline = require("readline");
const user_agents = require("./config/userAgents");
const settings = require("./config/config.js");
const { sleep, loadData, getRandomNumber, saveToken, isTokenExpired, saveJson } = require("./utils.js");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { checkBaseUrl } = require("./checkAPI");
const { headers } = require("./core/header.js");
const { showBanner } = require("./core/banner.js");
const localStorage = require("./localStorage.json");
const { Wallet, ethers } = require("ethers");
const { jwtDecode } = require("jwt-decode");

let REF_CODE = settings.REF_CODE;
let numberPerRef = settings.NUMBER_PER_REF;

class ClientAPI {
  constructor(itemData, accountIndex, proxy, baseURL, authInfos) {
    this.headers = headers;
    this.baseURL = baseURL;
    this.baseURL_v2 = "";

    this.itemData = itemData;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
    this.session_name = null;
    this.session_user_agents = this.#load_session_data();
    this.token = null;
    this.authInfos = authInfos;
    this.authInfo = { token: itemData.accessToken };
    this.localStorage = localStorage;
    this.wallet = new ethers.Wallet(this.itemData.privateKey);
  }

  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    console.log(`[Tài khoản ${this.accountIndex + 1}] Tạo user agent...`.blue);
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  #set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }

  createUserAgent() {
    try {
      this.session_name = this.itemData.address;
      this.#get_user_agent();
    } catch (error) {
      this.log(`Can't create user agent: ${error.message}`, "error");
      return;
    }
  }

  async log(msg, type = "info") {
    const accountPrefix = `[Parasail][Account ${this.accountIndex + 1}][${this.itemData.address}]`;
    let ipPrefix = "[Local IP]";
    if (settings.USE_PROXY) {
      ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : "[Unknown IP]";
    }
    let logMessage = "";

    switch (type) {
      case "success":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
        break;
      case "error":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
        break;
      case "warning":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
        break;
      case "custom":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.magenta;
        break;
      default:
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
    }
    console.log(logMessage);
  }

  async checkProxyIP() {
    try {
      const proxyAgent = new HttpsProxyAgent(this.proxy);
      const response = await axios.get("https://api.ipify.org?format=json", { httpsAgent: proxyAgent });
      if (response.status === 200) {
        this.proxyIP = response.data.ip;
        return response.data.ip;
      } else {
        throw new Error(`Cannot check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error checking proxy IP: ${error.message}`);
    }
  }

  async makeRequest(
    url,
    method,
    data = {},
    options = {
      retries: 1,
      isAuth: false,
    }
  ) {
    const { retries, isAuth } = options;

    const headers = {
      ...this.headers,
    };

    if (!isAuth) {
      headers["authorization"] = `Bearer ${this.token}`;
    }

    let proxyAgent = null;
    if (settings.USE_PROXY) {
      proxyAgent = new HttpsProxyAgent(this.proxy);
    }
    let currRetries = 0;
    do {
      try {
        const response = await axios({
          method,
          url: `${url}`,
          headers,
          timeout: 60000,
          ...(proxyAgent ? { httpsAgent: proxyAgent } : {}),
          ...(method.toLowerCase() != "get" ? { data: JSON.stringify(data || {}) } : {}),
        });
        if (response?.data?.data) return { status: response.status, success: true, data: response.data.data };
        return { success: true, data: response.data, status: response.status };
      } catch (error) {
        const errorMessage = error?.response?.data?.error || error?.response?.data?.message || error.message;
        // this.log(`Request failed: ${url} | ${error.message}...`, "warning");

        if (error.message.includes("stream has been aborted")) {
          return { success: false, status: error.status, data: null, error: errorMessage };
        }
        if (error.status == 401) {
          // this.log(`Error 401: ${JSON.stringify(error.response.data)}`, "warning");
          // let token = null;
          // token = await this.getValidToken(true);
          // if (!token) {
          //   process.exit(1);
          // }
          // this.token = token;
          // return this.makeRequest(url, method, data, options);
          return { success: false, status: error.status, data: error.response.data };
        }
        if (error.status == 400) {
          this.log(`Invalid request for ${url}, maybe have new update from server | contact: https://t.me/airdrophuntersieutoc to get new update!`, "error");
          return { success: false, status: error.status, error: errorMessage };
        }
        if (error.status == 429) {
          this.log(`Rate limit ${error.message}, waiting 30s to retries`, "warning");
          await sleep(60);
        }
        await sleep(settings.DELAY_BETWEEN_REQUESTS);
        currRetries++;
        if (currRetries > retries) {
          return { status: error.status, success: false, error: errorMessage };
        }
      }
    } while (currRetries <= retries);
  }

  async auth() {
    const wallet = this.wallet;
    const mess = `By signing this message, you confirm that you agree to the Parasail Terms of Service.\n\nParasail (including the Website and Parasail Smart Contracts) is not intended for:\n(a) access and/or use by Excluded Persons;\n(b) access and/or use by any person or entity in, or accessing or using the Website from, an Excluded Jurisdiction.\n\nExcluded Persons are prohibited from accessing and/or using Parasail (including the Website and Parasail Smart Contracts).\n\nFor full terms, refer to: https://parasail.network/Parasail_User_Terms.pdf\n`;
    const signedMessage = await wallet.signMessage(mess);
    const payload = {
      address: this.itemData.address,
      msg: mess,
      signature: signedMessage,
    };
    return this.makeRequest(`${this.baseURL}/user/verify`, "post", payload, { isAuth: true });
  }

  async nodeStatus() {
    return this.makeRequest(`${this.baseURL}/v1/node/node_stats?address=${this.itemData.address}`, "get");
  }

  async getSailPoints() {
    return this.makeRequest(`${this.baseURL}/user/sailpoints?address=${this.itemData.address}`, "get");
  }

  async aggregateStats() {
    return this.makeRequest(`${this.baseURL}/season/aggregate_stats?address=${this.itemData.address}`, "get");
  }

  async startNode() {
    return this.makeRequest(`${this.baseURL}/v1/node/check_in`, "post", {
      address: this.itemData.address,
    });
  }

  async onBoard() {
    return this.makeRequest(`${this.baseURL}/v1/node/onboard`, "post", {
      address: this.itemData.address,
    });
  }

  async getUserData() {
    return this.makeRequest(`${this.baseURL}/user/info?address=${this.itemData.address}`);
  }

  async login() {
    return this.makeRequest(`${this.baseURL}/user`, "post", {
      wallet: this.itemData.address,
      invite: settings.REF_CODE,
    });
  }

  async getTasks() {
    return this.makeRequest(`${this.baseURL}/season/user-tasks?address=${this.itemData.address}`, "get");
  }

  async completeTask(payload) {
    //     {
    //     "address": "0xF702063F779F88c5e10Ab00e3eF184879a9CEd16",
    //     "taskId": "TWITTER_CONNECT",
    //     "points": 500,
    //     "season": 0,
    //     "status": "COMPLETED",
    //     "daily": false
    // }
    return this.makeRequest(`${this.baseURL}/season/task`, "post", payload);
  }

  async checkSocial(payload) {
    //     {
    //     "address": "0xF702063F779F88c5e10Ab00e3eF184879a9CEd16",
    //     "type": "x",
    //     "id": "@",
    //     "name": "@"
    // }
    return this.makeRequest(`${this.baseURL}/season/task`, "post", payload);
  }

  async getTaskDetail(key) {
    //  "config": {
    //     "name": "retweet_tweet_id",
    //     "value": "1904793040990200021",
    //     "createdAt": "2025-03-26T12:08:12.374Z",
    //     "updatedAt": "2025-03-26T12:08:12.374Z"
    // }
    return this.makeRequest(`${this.baseURL}/season/operation-configs?name=${key}`, "get");
  }

  async claimTask(payload) {
    return this.makeRequest(`${this.baseURL}/v1/social/claim`, "post", payload);
  }

  async getValidToken(isNew = false) {
    const existingToken = this.token;
    const { isExpired: isExp, expirationDate } = isTokenExpired(existingToken);

    this.log(`Access token status: ${isExp ? "Expired".yellow : "Valid".green} | Acess token exp: ${expirationDate}`);
    if (existingToken && !isNew && !isExp) {
      this.log("Using valid token", "success");
      return existingToken;
    }

    this.log("No found token or experied, trying get new token...", "warning");
    const loginRes = await this.auth();
    if (!loginRes.success) return null;
    const newToken = loginRes.data;
    if (newToken?.token) {
      saveJson(this.session_name, JSON.stringify(newToken), "tokens.json");
      return newToken.token;
    }
    this.log("Can't get new token...", "warning");
    return null;
  }

  async handleSyncData() {
    this.log(`Sync data...`);
    let userData = { success: true, data: null, status: 0 },
      retries = 0;

    do {
      userData = await this.nodeStatus();
      if (userData?.success) break;
      retries++;
    } while (retries < 1 && userData.status !== 400);
    if (userData.success) {
      const resGet = await this.getSailPoints();
      const resAgg = await this.aggregateStats();

      const { total_distributed, pending_rewards, points } = userData.data;

      this.log(`Pedding reward: ${pending_rewards || 0} | Sail points: ${resGet.data?.points} | Node points: ${points + (resAgg.data?.seasonPoints || 0)}`, "custom");
    } else {
      return this.log("Can't sync new data...skipping", "warning");
    }
    return userData;
  }

  async handleTask() {
    let tasks = [];
    const keys = ["retweet_tweet_id", "comment_tweet_id"];
    const result = await this.getTasks();
    if (!result.success) return this.log("Can't get task, failed", "error");
    const tasksAvailable = result.data.tasks.filter((task) => task.status !== "COMPLETED" && !settings.SKIP_TASKS.includes(task.id));
    tasks = tasksAvailable;
    if (tasks.length == 0) return this.log(`No tasks available!`, "warning");
    for (const task of tasks) {
      await sleep(1);
      if (!task.completed) {
        this.log(`Trying complete task: ${task.id} | ${task.title}...`, "info");
        const resComplete = await this.completeTask({
          address: this.wallet.address,
          taskId: "DISCORD_JOIN_PARASAIL",
          points: task.amount,
          season: task.season,
          status: task.status,
          daily: false,
        });
        if (resComplete.success) {
          this.log(`Complete task ${task.id} | ${task.title} success`, "success");
        } else {
          this.log(`Can't complete task ${task.id} | ${task.title} | ${JSON.stringify(resComplete)}...`, "warning");
        }
      }
    }
  }

  async handleStartNode() {
    let isActive = false;
    const resCheck = await this.nodeStatus();
    await this.aggregateStats();
    if (!resCheck.success) return this.log(`Can't get information node status!`, "warning");
    const result = resCheck.data;
    if (!result.has_node) {
      this.log("Onboarding node...", "info");
      const createRes = await this.onBoard();
      if (!createRes.success) return this.log("Can't create node...skipping", "warning");
      else {
        isActive = true;
        this.log(`Onboarding node success! | ${JSON.stringify(createRes.data)}`, "success");
      }
    } else {
      const lastCheckin = result.last_checkin_time;
      const currentTime = Math.floor(Date.now() / 1000);
      const dateTime = 24 * 60 * 60; // 24h

      if (currentTime - dateTime >= lastCheckin) isActive = true;
      else {
        this.log(`Node is active! | Last checkin: ${new Date(lastCheckin * 1000).toLocaleString()}`, "warning");
      }
    }

    if (isActive) {
      const resStart = await this.startNode();
      if (!resStart.success) return this.log(`Can't start node!`, "warning");
      else this.log(`Start node sucess!`, "success");
    }
  }

  async runAccount() {
    const accountIndex = this.accountIndex;
    this.session_name = this.itemData.address;
    this.authInfo = JSON.parse(this.authInfos[this.session_name] || "{}");
    this.token = this.authInfo?.token;
    this.#set_headers();
    if (settings.USE_PROXY) {
      try {
        this.proxyIP = await this.checkProxyIP();
      } catch (error) {
        this.log(`Cannot check proxy IP: ${error.message}`, "warning");
        return;
      }
      const timesleep = getRandomNumber(settings.DELAY_START_BOT[0], settings.DELAY_START_BOT[1]);
      console.log(`=========Tài khoản ${accountIndex + 1} | ${this.proxyIP} | Bắt đầu sau ${timesleep} giây...`.green);
      await sleep(timesleep);
    }

    const token = await this.getValidToken();
    if (!token) return;
    this.token = token;
    const userData = await this.handleSyncData();
    if (userData.success) {
      await sleep(1);

      await this.handleStartNode(userData.data);
      // await sleep(1);
      if (settings.AUTO_TASK) {
        // await this.handleTask(userData.data);
        // await sleep(1);
      }
    } else {
      return this.log("Can't get user info...skipping", "error");
    }
  }
}

async function runWorker(workerData) {
  const { itemData, accountIndex, proxy, hasIDAPI, authInfos } = workerData;
  const to = new ClientAPI(itemData, accountIndex, proxy, hasIDAPI, authInfos);
  try {
    await Promise.race([to.runAccount(), new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 24 * 60 * 60 * 1000))]);
    parentPort.postMessage({
      accountIndex,
    });
  } catch (error) {
    parentPort.postMessage({ accountIndex, error: error.message });
  } finally {
    if (!isMainThread) {
      parentPort.postMessage("taskComplete");
    }
  }
}

async function main() {
  showBanner();
  const privateKeys = loadData("privateKeys.txt");
  const proxies = loadData("proxy.txt");
  let authInfos = require("./tokens.json");

  if (privateKeys.length == 0 || (privateKeys.length > proxies.length && settings.USE_PROXY)) {
    console.log("Số lượng proxy và data phải bằng nhau.".red);
    console.log(`Data: ${privateKeys.length}`);
    console.log(`Proxy: ${proxies.length}`);
    process.exit(1);
  }
  if (!settings.USE_PROXY) {
    console.log(`You are running bot without proxies!!!`.yellow);
  }
  let maxThreads = settings.USE_PROXY ? settings.MAX_THEADS : settings.MAX_THEADS_NO_PROXY;

  const resCheck = await checkBaseUrl();
  if (!resCheck.endpoint) return console.log(`Không thể tìm thấy ID API, có thể lỗi kết nỗi, thử lại sau!`.red);
  console.log(`${resCheck.message}`.yellow);

  const data = privateKeys.map((val, index) => {
    const prvk = val.startsWith("0x") ? val : `0x${val}`;
    const wallet = new ethers.Wallet(prvk);
    const item = {
      privateKey: prvk,
      address: wallet.address,
    };
    new ClientAPI(item, index, proxies[index], resCheck.endpoint, {}).createUserAgent();
    return item;
  });
  await sleep(1);
  while (true) {
    authInfos = require("./tokens.json");
    let currentIndex = 0;
    const errors = [];
    while (currentIndex < data.length) {
      const workerPromises = [];
      const batchSize = Math.min(maxThreads, data.length - currentIndex);
      for (let i = 0; i < batchSize; i++) {
        const worker = new Worker(__filename, {
          workerData: {
            hasIDAPI: resCheck.endpoint,
            itemData: data[currentIndex],
            accountIndex: currentIndex,
            proxy: proxies[currentIndex % proxies.length],
            authInfos: authInfos,
          },
        });

        workerPromises.push(
          new Promise((resolve) => {
            worker.on("message", (message) => {
              if (message === "taskComplete") {
                worker.terminate();
              }
              if (settings.ENABLE_DEBUG) {
                console.log(message);
              }
              resolve();
            });
            worker.on("error", (error) => {
              console.log(`Lỗi worker cho tài khoản ${currentIndex}: ${error?.message}`);
              worker.terminate();
              resolve();
            });
            worker.on("exit", (code) => {
              worker.terminate();
              if (code !== 0) {
                errors.push(`Worker cho tài khoản ${currentIndex} thoát với mã: ${code}`);
              }
              resolve();
            });
          })
        );

        currentIndex++;
      }

      await Promise.all(workerPromises);

      if (errors.length > 0) {
        errors.length = 0;
      }

      if (currentIndex < data.length) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    await sleep(3);
    console.log(`=============${new Date().toLocaleString()} | Hoàn thành tất cả tài khoản | Chờ ${settings.TIME_SLEEP} phút=============`.magenta);
    showBanner();
    await sleep(settings.TIME_SLEEP * 60);
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.log("Lỗi rồi:", error);
    process.exit(1);
  });
} else {
  runWorker(workerData);
}
