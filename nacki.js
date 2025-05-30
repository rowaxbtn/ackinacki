const fs = require('fs');
const path = require('path');
const axios = require('axios');
const colors = require('colors');
const readline = require('readline');
const { DateTime } = require('luxon');
const { HttpsProxyAgent } = require('https-proxy-agent');
const asynclib = require('async');

const TIMEOUT = 60000;
const MIN_RETRY_DELAY = 4; // 1 second
const MAX_RETRY_DELAY = 10; // 5 seconds
const MAX_RETRIES = 3;

class AckinackiAPIClient {
	constructor() {
        this.headers = this.getDefaultHeaders();
        this.limit_user_per_round = 25;
        this.waitTimes = [];
        this.proxies = [];
        this.proxyAgents = new Map(); // Cache proxy agents
        this.loadProxies();
	}
	
	getDefaultHeaders() {
		return {
			"Accept": "application/json, text/plain, */*",
			"Accept-Encoding": "gzip, deflate, br",
			"Accept-Language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
			"Origin": "https://t.ackinacki.com",
			"Referer": "https://t.ackinacki.com/",
			"Sec-Ch-Ua": '"Not/A)Brand";v="99", "Google Chrome";v="115", "Chromium";v="115"',
			"Sec-Ch-Ua-Mobile": "?0",
			"Sec-Ch-Ua-Platform": '"Windows"',
			"Sec-Fetch-Dest": "empty",
			"Sec-Fetch-Mode": "cors",
			"Sec-Fetch-Site": "cross-site",
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
		};
	}
	
    loadProxies() {
        const proxyFilePath = path.join(__dirname, 'proxy.txt');
        try {
			this.proxies = fs.readFileSync(proxyFilePath, 'utf8')
                .replace(/\r/g, '')
                .split('\n')
                .filter(Boolean);
            this.log(`Loaded ${this.proxies.length} proxies from proxy.txt`, 'success');
        } catch (error) {
            this.log(`Error loading proxy file: ${error.message}`, 'error');
        }
    }
	
    getProxyAgent(index) {
        if (!Array.isArray(this.proxies) || index >= this.proxies.length) return null;

        if (this.proxyAgents.has(index)) return this.proxyAgents.get(index);

        try {
            const agent = new HttpsProxyAgent(this.proxies[index]);
            this.proxyAgents.set(index, agent);
            return agent;
        } catch (error) {
            this.log(`Error creating proxy agent for proxy ${index + 1}: ${error.message}`, 'error');
            return null;
        }
    }

    getRandomWaitTime(min = 1, max = 5) {
        return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
    }

    async checkProxyIP(proxy, retries = MAX_RETRIES) {
        const proxyAgent = new HttpsProxyAgent(proxy);
        const url = 'https://api.ipify.org?format=json';

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const { status, data } = await axios.get(url, {
                    httpsAgent: proxyAgent,
                    timeout: TIMEOUT
                });

                if (status === 200) return data.ip;
                throw new Error(`Unexpected status code: ${status}`);
            } catch (error) {
                if (attempt < retries) {
                    this.log(`Attempt ${attempt} failed, retrying...`, 'warning');
                    await this.sleep(this.getRandomWaitTime(MIN_RETRY_DELAY, MAX_RETRY_DELAY));
                } else {
                    throw new Error(`Proxy IP check failed after ${retries} attempts: ${error.message}`);
                }
            }
        }
    }

    log(msg, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const logTypes = {
            success: `[${timestamp}] [✓] ${msg}`.green,
            error: `[${timestamp}] [✗] ${msg}`.red,
            warning: `[${timestamp}] [!] ${msg}`.yellow,
            custom: `[${timestamp}] [*] ${msg}`.magenta,
            info: `[${timestamp}] [ℹ] ${msg}`.blue
        };
        console.log(logTypes[type] || logTypes.info);
    }

    logError(msg, accInfo) {
        const timestamp = new Date().toLocaleTimeString();
        const { tgAuth, proxyAgent } = accInfo;
        const line = `[${timestamp}] [✗] ${msg} ${tgAuth} | ${proxyAgent}\n`;

        console.log(`[${timestamp}] [✗] ${msg}`.red);
        fs.appendFile('errorLog.txt', line, err => {
            if (err) console.error('Error appending to file:', err);
        });
    }

	async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async countdown(seconds) {
        while (seconds > 0) {
            const time = new Date().toLocaleTimeString();
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(`[${time}] [*] Waiting ${seconds--} seconds to continue...`);
            await this.sleep(1000);
        }
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
    }

    async apiRequest({ method, url, headers = {}, data = {}, proxyAgent = null, useRetry = false }) {
        const config = {
            method,
            url,
            headers: { ...this.headers, ...headers },
            data,
            timeout: TIMEOUT,
            ...(proxyAgent ? { httpsAgent: proxyAgent } : {})
        };
    
        const maxAttempts = useRetry ? MAX_RETRIES : 1;
    
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await axios(config);
                return { success: true, data: response.data, status: response.status };
            } catch (error) {
                const errorMessage = error.response?.data?.message || error.message;
                const errorStatus = error.response?.status || 'Unknown status';
                const errorData = error.response?.data || null;
    
                this.logError(`Attempt ${attempt} failed for ${method} ${url}: ${errorMessage}`, { headers, proxyAgent });
    
                if (attempt < maxAttempts) {
                    this.log(`Retrying (${attempt}/${maxAttempts})...`, 'warning');
                    await this.sleep(this.getRandomWaitTime(MIN_RETRY_DELAY, MAX_RETRY_DELAY));
                } else {
                    return { success: false, error: errorMessage, status: errorStatus, errorData: errorData };
                }
            }
        }
    }

    async getUserInfo(tgAuth, proxyAgent) {
        const url = "https://app-backend.ackinacki.org/api/users/me";
        const headers = { "Tg-Auth": tgAuth };

        const response = await this.apiRequest({ method: 'GET', url, headers, proxyAgent });

        if (!response.success) {
            this.logError(`Lỗi khi lấy thông tin tài khoản: ${response.error}`, { tgAuth, proxyAgent });
            return { success: false, error: response.error };
        }

        const userData = response.data;

        if (userData.user.is_adult === null) {
            this.log("Phát hiện tài khoản chưa xác nhận tuổi, đang xác nhận...", "warning");

            const patchResponse = await this.apiRequest({
                method: 'PATCH',
                url,
                headers,
                data: { "is_adult": true },
                proxyAgent
            });

            if (!patchResponse.success) {
                this.logError(`Không thể xác nhận tuổi: ${patchResponse.error}`, { tgAuth, proxyAgent });
                return { success: false, error: patchResponse.error };
            }

            this.log("Đã xác nhận trên 18 tuổi", "success");
            const boost = patchResponse.data.queue?.boost || 0;

            return {
                success: true,
                data: patchResponse.data,
                boost: boost
            };
        }

        const boost = userData.queue?.boost || 0;

        return {
            success: true,
            data: userData,
            boost: boost
        };
    }

    async checkFarmStatus(tgAuth, proxyAgent) {
        const url = "https://app-backend.ackinacki.org/api/users/tasks/farm/v2";
        const headers = { "Tg-Auth": tgAuth };
    
        const response = await this.apiRequest({ method: 'GET', url, headers, proxyAgent });
    
        if (!response.success) {
            this.logError(`Lỗi khi kiểm tra trạng thái farm: ${response.error}`, { tgAuth, proxyAgent });
            return { success: false, error: response.error };
        }
    
        const farmData = response.data;
    
        if (farmData.reward === null) {
            this.log("Không có farm đang hoạt động, bắt đầu farm mới...", "info");
    
            const startFarmResponse = await this.apiRequest({
                method: 'POST',
                url,
                headers,
                proxyAgent
            });
    
            if (!startFarmResponse.success) {
                this.logError(`Không thể bắt đầu farm mới: ${startFarmResponse.error}`, { tgAuth, proxyAgent });
                return { success: false, error: startFarmResponse.error };
            }
    
            this.log("Start farm thành công!", "success");
            return { success: true, status: "started", data: startFarmResponse.data };
        }
        if (farmData.reward.metadata && farmData.reward.metadata.start_at) {
            const startTime = DateTime.fromISO(farmData.reward.metadata.start_at);
            const currentTime = DateTime.now();
            if (currentTime < startTime) {
                const timeLeft = startTime.diff(currentTime).shiftTo('hours', 'minutes', 'seconds');
                const timeLeftFormatted = `${Math.floor(timeLeft.hours)}h ${Math.floor(timeLeft.minutes)}m ${Math.floor(timeLeft.seconds)}s`;
                const timeLeftSeconds = Math.floor(timeLeft.hours * 3600 + timeLeft.minutes * 60 + timeLeft.seconds);
    
                this.log(`Nông trại tiếp theo sẽ mở khóa sau: ${timeLeftFormatted}`, "warning");
                return {
                    success: true,
                    status: "locked",
                    timeLeft: timeLeftFormatted,
                    timeLeftSeconds: timeLeftSeconds,
                    unlockTime: startTime.toFormat('HH:mm:ss dd-MM-yyyy')
                };
            }else{
                this.log("Bắt đầu farm mới...", "info");
                const startFarmResponse = await this.apiRequest({
                    method: 'POST',
                    url,
                    headers,
                    proxyAgent
                });
        
                if (!startFarmResponse.success) {
                    this.logError(`Không thể bắt đầu farm mới: ${startFarmResponse.error}`, { tgAuth, proxyAgent });
                    return { success: false, error: startFarmResponse.error };
                }
        
                this.log("Start farm thành công!", "success");
                return { success: true, status: "started", data: startFarmResponse.data };
            }
        }
    
        const claimTime = DateTime.fromISO(farmData.reward.claim_at);
        const currentTime = DateTime.now();
    
        if (currentTime >= claimTime) {
            this.log("Đủ điều kiện để claim phần thưởng farm", "info");
    
            const claimResponse = await this.apiRequest({
                method: 'POST',
                url: "https://app-backend.ackinacki.org/api/users/tasks/claim",
                headers,
                data: { task_id: farmData.id },
                proxyAgent
            });
    
            if (!claimResponse.success) {
                this.logError(`Không thể claim phần thưởng: ${claimResponse.error}`, { tgAuth, proxyAgent });
                return { success: false, error: claimResponse.error };
            }
    
            this.log(`Claim thành công! Nhận được ${farmData.reward.reward} boost`, "success");
    
            this.log("Đang bắt đầu farm mới...", "info");
            const startNewFarmResponse = await this.apiRequest({
                method: 'POST',
                url,
                headers,
                proxyAgent
            });
    
            if (!startNewFarmResponse.success) {
                this.logError(`Không thể bắt đầu farm mới: ${startNewFarmResponse.error}`, { tgAuth, proxyAgent });
                return { success: true, status: "claimed", reward: farmData.reward.reward };
            }
    
            this.log("Bắt đầu farm mới thành công!", "success");
            return {
                success: true,
                status: "claimed_and_restarted",
                reward: farmData.reward.reward,
                newStatus: await this.checkFarmStatus(tgAuth, proxyAgent)
            };
        } else {
            const timeLeft = claimTime.diff(currentTime).shiftTo('hours', 'minutes', 'seconds');
            const timeLeftFormatted = `${Math.floor(timeLeft.hours)}h ${Math.floor(timeLeft.minutes)}m ${Math.floor(timeLeft.seconds)}s`;
            const timeLeftSeconds = Math.floor(timeLeft.hours * 3600 + timeLeft.minutes * 60 + timeLeft.seconds);
    
            this.log(`Chưa đến thời gian claim. Còn lại: ${timeLeftFormatted}`, "warning");
            return {
                success: true,
                status: "waiting",
                timeLeft: timeLeftFormatted,
                timeLeftSeconds: timeLeftSeconds,
                claimTime: claimTime.toFormat('HH:mm:ss dd-MM-yyyy')
            };
        }
    }

    async checkUnclaimedRewards(tgAuth, proxyAgent) {
        const url = "https://app-backend.ackinacki.org/api/users/tasks/unclaimed";
        const headers = { "Tg-Auth": tgAuth };

        const response = await this.apiRequest({ method: 'GET', url, headers, proxyAgent });

        if (!response.success) {
            this.logError(`Lỗi khi claim phần thưởng: ${response.error}`, { tgAuth, proxyAgent });
            if (response.errorData) {
                this.logError(`Chi tiết lỗi: ${JSON.stringify(response.errorData)}`, { tgAuth, proxyAgent });
            }
            return { success: false, error: response.error };
        }

        const unclaimedRewards = response.data;
        if (!unclaimedRewards.length) {
            this.log("Không có phần thưởng chưa nhận", "info");
            return { success: true, status: "no_rewards" };
        }

        const totalBoost = unclaimedRewards.reduce((sum, reward) => sum + reward.rewards, 0);
        this.log(`Có ${unclaimedRewards.length} phần thưởng chưa nhận | ${totalBoost} boost`, "warning");

        const claimResponse = await this.apiRequest({
            method: 'POST',
            url: "https://app-backend.ackinacki.org/api/users/tasks/claim",
            headers,
            proxyAgent
        });

        if (!claimResponse.success) {
            this.logError(`Không thể nhận phần thưởng: ${claimResponse.error}`, { tgAuth, proxyAgent });
            return { success: false, error: claimResponse.error };
        }

        this.log(`Nhận tất cả phần thưởng thành công! +${totalBoost} boost`, "success");
        return { success: true, status: "claimed", rewardsCount: unclaimedRewards.length, totalRewards: totalBoost };
    }
        
    async executeAdsPopitTasks(tgAuth, proxyAgent) {
        const headers = { "Tg-Auth": tgAuth };

        try {
            this.log('Đang lấy danh sách popcoins...', 'info');
            const popcoinsResponse = await this.apiRequest({
                method: 'GET',
                url: 'https://app-backend.ackinacki.org/api/popits/popcoins?cursor=0',
                headers,
                proxyAgent
            });
    
            if (!popcoinsResponse.success) {
                this.logError(`Lỗi khi lấy danh sách popcoins: ${popcoinsResponse.error}`, { tgAuth, proxyAgent });
                return { success: false, error: popcoinsResponse.error };
            }
    
            const popcoins = popcoinsResponse.data.data;
            const adsPopcoin = popcoins.find(coin => coin.token_symbol === 'ADS');
    
            if (!adsPopcoin) {
                this.logError('Không tìm thấy popcoin ADS!', { tgAuth, proxyAgent });
                return { success: false, error: 'ADS popcoin not found' };
            }
    
            this.log(`Đã tìm thấy popcoin ADS (ID: ${adsPopcoin.id})`, 'success');
    
            let totalTasksExecuted = 0;
            let totalTasksSkipped = 0;
            let totalTasksFailed = 0;
    
            this.log(`Đang lấy danh sách popits cho ADS (ID: ${adsPopcoin.id})...`, 'info');
            const popitsResponse = await this.apiRequest({
                method: 'GET',
                url: `https://app-backend.ackinacki.org/api/popits?cursor=0&popcoin_id=${adsPopcoin.id}&popcoin_only=true&limit=20`,
                headers,
                proxyAgent
            });
    
            if (!popitsResponse.success) {
                this.logError(`Lỗi khi lấy danh sách popits: ${popitsResponse.error}`, { tgAuth, proxyAgent });
                return { success: false, error: popitsResponse.error };
            }
    
            const popits = popitsResponse.data.data;
            this.log(`Đã tìm thấy ${popits.length} popits cho ADS`, 'success');
    
            for (const popit of popits) {
                if (!popit.user_task || !popit.user_task.id) {
                    this.log(`Không có task cho popit ID: ${popit.id}`, 'warning');
                    totalTasksSkipped++;
                    continue;
                }
    
                const taskId = popit.user_task.id;
                const taskName = popit.user_task.name || 'Unnamed Task';
                const reward = popit.user_task.const_reward || 0;
    
                this.log(`Đang làm nhiệm vụ ${taskName} | Phần thưởng : ${reward}`, 'custom');
    
                const taskResponse = await this.apiRequest({
                    method: 'POST',
                    url: `https://app-backend.ackinacki.org/api/users/tasks/${taskId}/start`,
                    headers,
                    proxyAgent
                });
    
                if (taskResponse.success) {
                    this.log(`Hoàn thành nhiệm vụ: ${taskName}`, 'success');
                    totalTasksExecuted++;
                } else {
                    this.logError(`Không thể hoàn thành nhiệm vụ: ${taskResponse.error}`, { tgAuth, proxyAgent });
                    totalTasksFailed++;
                }
    
                await this.countdown(3);
            }
    
            this.log(`Tổng kết nhiệm vụ ADS: ${totalTasksExecuted} thành công, ${totalTasksSkipped} đã làm trước đó, ${totalTasksFailed} thất bại`, 'custom');
    
            return {
                success: true,
                tasksExecuted: totalTasksExecuted,
                tasksSkipped: totalTasksSkipped,
                tasksFailed: totalTasksFailed
            };
        } catch (error) {
            this.logError(`Lỗi không xác định: ${error.message}`, { tgAuth, proxyAgent });
            return { success: false, error: error.message };
        }
    }
	
	async startMission(tgAuth, i) {
		const proxyAgent = this.getProxyAgent(i);
		let proxyIP = "không có proxy";

		if (proxyAgent && this.proxies[i]) {
			try {
				proxyIP = await this.checkProxyIP(this.proxies[i]);
			} catch (error) {
				this.logError(`Không thể kiểm tra proxy sau nhiều lần thử: ${error.message}`, { tgAuth, proxyAgent });
			}
		}

		console.log(`========== Tài khoản ${i + 1} | IP: ${proxyIP} ==========`);
		const userInfoResult = await this.getUserInfo(tgAuth, proxyAgent);
		if (!userInfoResult.success) {
			this.logError(`Không thể lấy thông tin tài khoản: ${userInfoResult.error}`, { tgAuth, proxyAgent });
			return;
		}

		this.log(`Boost: ${userInfoResult.boost}`, 'custom');
		this.log(`Đang thực hiện các nhiệm vụ ADS...`, 'info');

		const adsPopitResult = await this.executeAdsPopitTasks(tgAuth, proxyAgent);
		if (!adsPopitResult.success) {
			this.logError(`Có lỗi khi thực hiện nhiệm vụ ADS: ${adsPopitResult.error}`, { tgAuth, proxyAgent });
		} else {
			this.log(`Đã hoàn thành nhiệm vụ`, 'success');
		}

		await this.handleUnclaimedRewards(tgAuth, proxyAgent);
		const waitTime = await this.handleFarmStatus(tgAuth, proxyAgent);
		this.waitTimes.push(waitTime);
	}
	
	async handleUnclaimedRewards(tgAuth, proxyAgent) {
		this.log(`Kiểm tra phần thưởng chưa nhận...`, 'info');
		const result = await this.checkUnclaimedRewards(tgAuth, proxyAgent);

		if (!result.success) {
			this.logError(`Lỗi khi kiểm tra phần thưởng: ${result.error}`, { tgAuth, proxyAgent });
			return;
		}

		if (result.status === "claimed") {
			this.log(`Đã nhận tổng cộng ${result.totalRewards} boost từ ${result.rewardsCount} phần thưởng!`, 'custom');
		}
	}

	async handleFarmStatus(tgAuth, proxyAgent) {
		let longestWait = 0;
		this.log(`Kiểm tra trạng thái farm...`, 'info');
		const result = await this.checkFarmStatus(tgAuth, proxyAgent);

		if (!result.success) {
			this.logError(`Lỗi khi kiểm tra farm: ${result.error}`, { tgAuth, proxyAgent });
			return longestWait;
		}

		const updateLongestWait = (time) => {
			if (time > longestWait) longestWait = time;
		};

		const handleStatus = (status) => {
            switch (status.status) {
                case "waiting":
                    this.log(`Thời gian claim tiếp theo: ${status.claimTime}`, 'custom');
                    updateLongestWait(status.timeLeftSeconds);
                    break;
    
                case "locked":
                    this.log(`Nông trại sẽ mở khóa vào: ${status.unlockTime}`, 'custom');
                    updateLongestWait(status.timeLeftSeconds);
                    break;
    
                case "claimed":
                    this.log(`Farm đã được claim thành công!`, 'success');
                    break;
    
                case "claimed_and_restarted":
                    this.log(`Farm đã được claim và bắt đầu farm mới thành công!`, 'success');
                    if (status.newStatus) handleStatus(status.newStatus);
                    break;
    
                case "started":
                    this.log(`Farm đã được bắt đầu, kiểm tra lại sau.`, 'info');
                    break;
    
                default:
                    this.log(`Trạng thái không xác định: ${status.status}`, 'warning');
            }
        };
    
        handleStatus(result);
    
        if (result.status === "started") {
            const newStatus = await this.checkFarmStatus(tgAuth, proxyAgent);
            if (newStatus.success) handleStatus(newStatus);
        }
    
        return longestWait;
	}
	
    async main() {
        const dataFile = path.join(__dirname, 'data.txt');
        const users = fs.readFileSync(dataFile, 'utf8')
            .replace(/\r/g, '')
            .split('\n')
            .filter(Boolean);
    
        const runMissions = async () => {
            this.waitTimes = [];
            await new Promise((resolve, reject) => {
                asynclib.eachOfLimit(users, this.limit_user_per_round, async (user, index) => {
                    await this.startMission(user, index);
                }, (err) => {
                    if (err) {
                        this.log("Error running multi-users: " + err.message, 'error');
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
    
            const maxWait = Math.max(...this.waitTimes, 0);
            const waitTimeInSeconds = Math.min(maxWait > 0 ? maxWait + 5 : 7200, 7200);
    
            this.log(`Sử dụng thời gian chờ: ${Math.floor(waitTimeInSeconds / 3600)}h ${Math.floor((waitTimeInSeconds % 3600) / 60)}m ${waitTimeInSeconds % 60}s`, 'custom');
            await this.countdown(waitTimeInSeconds);
    
            setTimeout(runMissions, 0); // Schedule the next iteration
        };
    
        runMissions();
    }
}

const client = new AckinackiAPIClient();
client.main().catch(err => {
    client.log(err.message, 'error');
    process.exit(1);
});