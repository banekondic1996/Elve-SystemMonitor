const { exec } = require('child_process');
const os = require('os');
const fs = require('fs');

// Global state
let processes = [];
let filteredProcesses = [];
let selectedPID = null;
let sortColumn = 'cpu';
let sortDirection = -1;
let totalRAM = 1;
let totalGPU = 0;
let isWindowVisible = true;
let updateIntervals = [];
let allServices = [];
let serviceStates = {};
let currentServiceScrollPos = 0;
let diskIOData = {};
let lastDiskStats = null;
let diskIOInterval = null;
let networkMonitorInterval = null;
let currentview;
let settings = {
    showProcessDiskIO: false,
    showProcessGPU: true
};
let historyData = {
    cpu: [], memory: [], networkDown: [], networkUp: [], temp: [], diskRead: [], diskWrite: []
};
const maxHistoryPoints = 60;

// Load settings from localStorage
try {
    const savedSettings = localStorage.getItem('elve-monitor-settings');
    if (savedSettings) {
        settings = { ...settings, ...JSON.parse(savedSettings) };
    }
} catch (e) {
    console.log('Could not load settings:', e);
}

// Chart functions
function initCharts() {
    drawChart('cpu-chart', historyData.cpu, '#4ec9b0', 100, '%');
    drawChart('memory-chart', historyData.memory, '#0e639c', 100, '%');
    drawChart('network-down-chart', historyData.networkDown, '#c586c0', null, 'KB/s');
    drawChart('network-up-chart', historyData.networkUp, '#ce9178', null, 'KB/s');
    drawChart('temp-chart', historyData.temp, '#d16969', 100, '°C');
    drawChart('disk-read-chart', historyData.diskRead, '#4ec9b0', null, 'MB/s');
    drawChart('disk-write-chart', historyData.diskWrite, '#ce9178', null, 'MB/s');
}

function drawChart(canvasId, data, color, maxValue, unit) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const paddingLeft = 40, paddingRight = 20, paddingTop = 40, paddingBottom = 40;
    const width = rect.width, height = rect.height;
    const chartWidth = width - paddingLeft - paddingRight;
    const chartHeight = height - paddingTop - paddingBottom;

    ctx.clearRect(0, 0, width, height);
    if (data.length < 2) return;

    const max = maxValue || Math.max(...data, 1);
    const step = chartWidth / (maxHistoryPoints - 1);
    canvas.dataPoints = [];

    ctx.strokeStyle = '#3e3e42';
    ctx.fillStyle = '#999';
    ctx.font = '11px sans-serif';
    ctx.lineWidth = 1;

    for (let i = 0; i <= 4; i++) {
        const y = paddingTop + (chartHeight / 4) * i;
        const value = max - (max / 4) * i;
        ctx.beginPath();
        ctx.moveTo(paddingLeft, y);
        ctx.lineTo(width - paddingRight, y);
        ctx.stroke();
        ctx.fillText(value.toFixed(1), 2, y + 4);
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();

    data.forEach((value, i) => {
        value = Math.abs(value);
        const x = paddingLeft + i * step;
        const y = paddingTop + chartHeight - (value / max) * chartHeight;
        canvas.dataPoints.push({ x, y, value, index: i });
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });

    ctx.stroke();
    ctx.lineTo(paddingLeft + chartWidth, paddingTop + chartHeight);
    ctx.lineTo(paddingLeft, paddingTop + chartHeight);
    ctx.closePath();
    ctx.fillStyle = color + '20';
    ctx.fill();

    if (data.length > 0) {
        const lastValue = data[data.length - 1];
        const lastX = paddingLeft + (data.length - 1) * step;
        const lastY = paddingTop + chartHeight - (lastValue / max) * chartHeight;
        ctx.font = 'bold 12px sans-serif';
        const label = lastValue.toFixed(1) + (unit || '');
        const labelWidth = ctx.measureText(label).width;
        const labelX = Math.min(lastX - labelWidth / 2, width - labelWidth - paddingRight - 8);
        const labelY = lastY - 10;
        ctx.fillStyle = 'rgba(37, 37, 38, 0.8)';
        ctx.fillRect(labelX - 4, labelY - 12, labelWidth + 8, 16);
        ctx.fillStyle = color;
        ctx.fillText(label, labelX, labelY);
    }

    setupChartHover(canvas, canvasId, unit);
}

function setupChartHover(canvas, canvasId, unit) {
    const tooltip = document.getElementById(canvasId.replace('-chart', '-tooltip'));
    if (!tooltip) return;
    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        let closestPoint = null, minDist = Infinity;
        if (canvas.dataPoints) {
            canvas.dataPoints.forEach(point => {
                const dist = Math.sqrt(Math.pow(mouseX - point.x, 2) + Math.pow(mouseY - point.y, 2));
                if (dist < minDist && dist < 20) {
                    minDist = dist;
                    closestPoint = point;
                }
            });
        }
        if (closestPoint) {
            tooltip.style.display = 'block';
            tooltip.style.left = (e.clientX - rect.left + 15) + 'px';
            tooltip.style.top = (e.clientY - rect.top - 30) + 'px';
            tooltip.textContent = `Value: ${closestPoint.value.toFixed(2)}${unit || ''}`;
        } else {
            tooltip.style.display = 'none';
        }
    });
    canvas.addEventListener('mouseleave', () => tooltip.style.display = 'none');
}

// System monitoring functions
function getCPUUsage(callback) {
    exec("top -bn2 -d 0.5 | grep 'Cpu(s)' | tail -1 | awk '{print $2}' | cut -d'%' -f1", (err, stdout) => {
        callback(err ? 0 : parseFloat(stdout) || 0);
    });
}

function getMemoryUsage(callback) {
    exec("free -m | grep Mem | awk '{print $3,$2}'", (err, stdout) => {
        if (err) return callback({ used: 0, total: 1, percent: 0 });
        const parts = stdout.trim().split(' ');
        const used = parseInt(parts[0]), total = parseInt(parts[1]);
        totalRAM = total;
        callback({ used: used / 1024, total: total / 1024, percent: (used / total) * 100 });
    });
}

function getDiskUsage(callback) {
    exec("df -h / | tail -1 | awk '{print $3,$2,$5}'", (err, stdout) => {
        if (err) return callback({ used: '0G', total: '0G', percent: 0 });
        const parts = stdout.trim().split(' ');
        callback({ used: parts[0], total: parts[1], percent: parseInt(parts[2]) });
    });
}

function getNetworkUsage(callback) {
    exec("cat /proc/net/dev | grep -E 'eth0|wlan0|enp|wlp' | head -1 | awk '{print $2,$10}'", (err, stdout) => {
        if (err) return callback({ down: 0, up: 0 });
        const parts = stdout.trim().split(' ');
        const rx = parseInt(parts[0]) || 0, tx = parseInt(parts[1]) || 0;
        if (!getNetworkUsage.lastRx) {
            getNetworkUsage.lastRx = rx;
            getNetworkUsage.lastTx = tx;
            getNetworkUsage.lastTime = Date.now();
            return callback({ down: 0, up: 0 });
        }
        const timeDiff = (Date.now() - getNetworkUsage.lastTime) / 1000;
        const rxDiff = (rx - getNetworkUsage.lastRx) / timeDiff / 1024;
        const txDiff = (tx - getNetworkUsage.lastTx) / timeDiff / 1024;
        getNetworkUsage.lastRx = rx;
        getNetworkUsage.lastTx = tx;
        getNetworkUsage.lastTime = Date.now();
        callback({ down: rxDiff, up: txDiff });
    });
}

function getTemperature(callback) {
    const cmd = `
    cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || 
    sensors | grep -E '^(Core|Package|Tdie|Tctl)' | head -n1 | 
    awk '{print $2}' | tr -d '+°C'
    `;

    exec(cmd, (err, stdout) => {
        if (err || !stdout) return callback(0);

        let temp = parseFloat(stdout.trim());
        if (isNaN(temp)) return callback(0);

        // Convert millidegrees to degrees if necessary
        if (temp > 1000) temp = temp / 1000;
        callback(temp);
    });
}

function getDiskIO(callback) {
    exec("cat /proc/diskstats | grep -E 'sda|nvme0n1|vda' | head -1", (err, stdout) => {
        if (err) return callback({ read: 0, write: 0 });
        const parts = stdout.trim().split(/\s+/);
        const sectorsRead = parseInt(parts[5]) || 0;
        const sectorsWritten = parseInt(parts[9]) || 0;
        
        if (!lastDiskStats) {
            lastDiskStats = { sectorsRead, sectorsWritten, time: Date.now() };
            return callback({ read: 0, write: 0 });
        }
        
        const timeDiff = (Date.now() - lastDiskStats.time) / 1000;
        const readDiff = ((sectorsRead - lastDiskStats.sectorsRead) * 512) / timeDiff / 1024 / 1024; // MB/s
        const writeDiff = ((sectorsWritten - lastDiskStats.sectorsWritten) * 512) / timeDiff / 1024 / 1024; // MB/s
        
        lastDiskStats = { sectorsRead, sectorsWritten, time: Date.now() };
        callback({ read: Math.max(0, readDiff), write: Math.max(0, writeDiff) });
    });
}

function getProcessDiskIO(callback) {
    exec("for pid in /proc/[0-9]*; do p=$(basename $pid); if [ -f $pid/io ]; then echo \"$p $(cat $pid/io 2>/dev/null | grep -E 'read_bytes|write_bytes' | awk '{print $2}' | paste -sd' ')\"; fi; done", (err, stdout) => {
        if (err) return callback({});
        const ioData = {};
        stdout.trim().split('\n').forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3) {
                const pid = parseInt(parts[0]);
                const readBytes = parseInt(parts[1]) || 0;
                const writeBytes = parseInt(parts[2]) || 0;
                
                if (diskIOData[pid]) {
                    const timeDiff = 2;
                    const readDiff = (readBytes - diskIOData[pid].readBytes) / timeDiff / 1024 / 1024; // MB/s
                    const writeDiff = (writeBytes - diskIOData[pid].writeBytes) / timeDiff / 1024 / 1024; // MB/s
                    ioData[pid] = { 
                        readMBs: Math.max(0, readDiff), 
                        writeMBs: Math.max(0, writeDiff),
                        total: Math.max(0, readDiff + writeDiff)
                    };
                }
                diskIOData[pid] = { readBytes, writeBytes };
            }
        });
        callback(ioData);
    });
}

function getProcesses(callback) {
    exec("ps aux --sort=-%cpu | head -100", (err, stdout) => {
        if (err) return callback([]);
        const lines = stdout.trim().split('\n').slice(1);
        const procs = lines.map(line => {
            const parts = line.trim().split(/\s+/);
            const fullCommand = parts.slice(10).join(' ');
            let shortName = fullCommand;
            const executable = fullCommand.split(' ')[0];
            if (executable.includes('/')) shortName = executable.split('/').pop();
            else shortName = executable;
            shortName = shortName.replace(/\.bin$/, '').replace(/\.exe$/, '');
            if(shortName!="ps"){
            return {
                user: parts[0], pid: parseInt(parts[1]), cpu: parseFloat(parts[2]),
                memory: parseFloat(parts[3]), memoryMB: parseFloat(parts[5]) / 1024,
                gpu: 0, vram: 0, diskRead: 0, diskWrite: 0,
                name: shortName, fullCommand: fullCommand
            };
            }
             else{
                return {
                user: parts[0], pid: parseInt(parts[1]), cpu: 0,
                memory: parseFloat(parts[3]), memoryMB: parseFloat(parts[5]) / 1024,
                gpu: 0, vram: 0, diskRead: 0, diskWrite: 0,
                name: shortName, fullCommand: fullCommand
            }
            }
        });
        
        if (settings.showProcessDiskIO) {
            getProcessDiskIO((ioData) => {
                getGPUUsage((gpuData) => {
                    procs.forEach(proc => {
                        if (ioData[proc.pid]) {
                            proc.diskRead = ioData[proc.pid].readMBs;
                            proc.diskWrite = ioData[proc.pid].writeMBs;
                        }
                        if (gpuData[proc.pid]) {
                            proc.gpu = gpuData[proc.pid].usage;
                            proc.vram = gpuData[proc.pid].vram;
                        }
                    });
                    callback(procs);
                });
            });
        } else {
            getGPUUsage((gpuData) => {
                //DISABLED
/*                 procs.forEach(proc => {
                    if (gpuData[proc.pid]) {
                        proc.gpu = gpuData[proc.pid].usage;
                        proc.vram = gpuData[proc.pid].vram;
                    }
                }); */
                callback(procs);
            });
        }
    });
}

function getGPUUsage(callback) {
    const gpuData = {};
    let totalUsage = 0, gpuCount = 0, completedChecks = 0;
    
    function checkComplete() {
        completedChecks++;
        if (completedChecks === 3) {
            totalGPU = gpuCount > 0 ? totalUsage / gpuCount : 0;
            callback(gpuData);
        }
    }
    
    exec("nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null", (err, stdout) => {
        if (!err && stdout) {
            stdout.trim().split('\n').forEach(line => {
                const parts = line.split(',').map(p => p.trim());
                if (parts.length >= 2) {
                    const pid = parseInt(parts[0]), vramMB = parseFloat(parts[1]);
                    if (!gpuData[pid]) gpuData[pid] = { usage: 0, vram: 0 };
                    gpuData[pid].vram = vramMB;
                    const usage = Math.min((vramMB / 1024) * 10, 100);
                    gpuData[pid].usage = usage;
                    totalUsage += usage;
                    gpuCount++;
                }
            });
        }
        checkComplete();
    });
    
    exec("timeout 0.5 intel_gpu_top -l -s 100 2>/dev/null | grep -E '^[0-9]' | head -20", (err, stdout) => {
        if (!err && stdout) {
            stdout.trim().split('\n').forEach(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                    const pid = parseInt(parts[0]), usage = parseFloat(parts[1]);
                    if (!isNaN(pid) && !isNaN(usage)) {
                        if (!gpuData[pid]) gpuData[pid] = { usage: 0, vram: 0 };
                        gpuData[pid].usage = Math.max(gpuData[pid].usage, usage);
                        totalUsage += usage;
                        gpuCount++;
                    }
                }
            });
        }
        checkComplete();
    });
    
    exec("cat /sys/kernel/debug/dri/0/amdgpu_gem_info 2>/dev/null | grep -E 'pid|VRAM'", (err, stdout) => {
        if (!err && stdout) {
            const lines = stdout.split('\n');
            let currentPid = null;
            lines.forEach(line => {
                const pidMatch = line.match(/pid\s+(\d+)/);
                if (pidMatch) currentPid = parseInt(pidMatch[1]);
                const vramMatch = line.match(/VRAM:\s+(\d+)\s+KiB/);
                if (vramMatch && currentPid) {
                    const vramMB = parseInt(vramMatch[1]) / 1024;
                    if (!gpuData[currentPid]) gpuData[currentPid] = { usage: 0, vram: 0 };
                    gpuData[currentPid].vram = Math.max(gpuData[currentPid].vram, vramMB);
                    const usage = Math.min((vramMB / 1024) * 15, 100);
                    gpuData[currentPid].usage = Math.max(gpuData[currentPid].usage, usage);
                    totalUsage += usage;
                    gpuCount++;
                }
            });
        }
        checkComplete();
    });
}

function killProcess(pid) {
    if (!confirm(`Kill process ${pid}?`)) return;
    exec(`kill -9 ${pid}`, (err) => {
        alert(err ? `Failed: ${err.message}` : `Process ${pid} terminated`);
        if (!err) refreshProcesses();
    });
}

function getCPUColor(p) {
    if (p < 25) return 'rgba(78, 201, 176, 0.1)';
    if (p < 50) return 'rgba(255, 160, 159, 0.1)';
    if (p < 75) return 'rgba(214, 157, 133, 0.3)';
    return 'rgba(197, 42, 42, 0.5)';
}

function getMemoryColor(mb) {
    const p = (mb / totalRAM) * 100;
    if (p < 1) return 'rgba(78, 201, 176, 0.1)';
    if (p < 5) return 'rgba(255, 160, 159, 0.1)';
    if (p < 10) return 'rgba(214, 157, 133, 0.3)';
    return 'rgba(197, 42, 42, 0.5)';
}

function updateSystemStats() {
    getCPUUsage(cpu => {
        document.getElementById('cpu-stat').textContent = cpu.toFixed(1) + '%';
        historyData.cpu.push(cpu);
    });
    getMemoryUsage(mem => {
        document.getElementById('memory-stat').textContent = mem.percent.toFixed(1) + '%';
        document.getElementById('memory-detail').textContent = `${mem.used.toFixed(1)}/${mem.total.toFixed(1)} GB`;
        historyData.memory.push(mem.percent);
    });
    getDiskUsage(disk => {
        document.getElementById('disk-stat').textContent = disk.percent + '%';
        document.getElementById('disk-detail').textContent = `${disk.used}/${disk.total}`;
    });
    getNetworkUsage(net => {
        document.getElementById('network-stat').textContent = `↓ ${net.down.toFixed(1)} KB/s`;
        document.getElementById('network-upload').textContent = `↑ ${net.up.toFixed(1)} KB/s`;
        historyData.networkDown.push(net.down);
        historyData.networkUp.push(net.up);
    });
    getDiskIO(diskIO => {
        document.getElementById('disk-read-stat').textContent = `↓ ${diskIO.read.toFixed(1)} MB/s`;
        document.getElementById('disk-write-stat').textContent = `↑ ${diskIO.write.toFixed(1)} MB/s`;
        historyData.diskRead.push(diskIO.read);
        historyData.diskWrite.push(diskIO.write);
    });
    getTemperature(temp => {
        document.getElementById('temp-stat').textContent = temp + '°C';
        historyData.temp.push(temp);
    });
    document.getElementById('gpu-stat').textContent = totalGPU.toFixed(1) + '%';
    
    if (historyData.cpu.length > maxHistoryPoints) {
        Object.keys(historyData).forEach(key => historyData[key].shift());
    }
    
    if (!document.getElementById('performance-view').classList.contains('hidden')) initCharts();
}

function refreshProcesses() {
    if (!isWindowVisible) return;
    getProcesses(procs => {
        processes = procs;
        applySearch();
    });
    updateSystemStats();
}

function applySearch() {
    const term = document.getElementById('process-search').value.toLowerCase();
    filteredProcesses = term ? processes.filter(p => 
        p.name.toLowerCase().includes(term) ||
        p.pid.toString().includes(term) ||
        p.user.toLowerCase().includes(term)
    ) : processes;
    sortProcesses();
    renderProcessTable();
}

function sortProcesses() {
    filteredProcesses.sort((a, b) => (a[sortColumn] - b[sortColumn]) * sortDirection);
}

function renderProcessTable() {
    const tbody = document.getElementById('process-tbody');
    const thead = document.querySelector('#processes-view table thead tr');
    
    // Update table headers based on settings
    let headers = `
        <th data-sort="pid">PID</th>
        <th data-sort="name">Name</th>
        <th data-sort="cpu">CPU %</th>
        <th data-sort="memory">Memory</th>
    `;
    
    if (settings.showProcessDiskIO) {
        headers += `
            <th data-sort="diskRead">Disk R</th>
            <th data-sort="diskWrite">Disk W</th>
        `;
    }
    
    if (settings.showProcessGPU) {
        headers += `
            <th data-sort="gpu">GPU %</th>
            <th data-sort="vram">VRAM</th>
        `;
    }
    
    headers += `<th data-sort="user">User</th>`;
    thead.innerHTML = headers;
    
    // Re-attach click handlers to headers
    thead.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (sortColumn === col) sortDirection *= -1;
            else { sortColumn = col; sortDirection = -1; }
            sortProcesses();
            renderProcessTable();
        });
    });
    
    // Update table body
    tbody.innerHTML = filteredProcesses.map(p => {
        let row = `
            <tr data-pid="${p.pid}" ${selectedPID === p.pid ? 'class="selected"' : ''}>
                <td>${p.pid}</td>
                <td title="${p.fullCommand}">${p.name}</td>
                <td class="cpu-cell" style="background: ${getCPUColor(p.cpu)}">${p.cpu.toFixed(1)}%</td>
                <td class="memory-cell" style="background: ${getMemoryColor(p.memoryMB)}">${p.memoryMB.toFixed(1)} MB</td>
        `;
        
        if (settings.showProcessDiskIO) {
            row += `
                <td>${p.diskRead.toFixed(1)} MB/s</td>
                <td>${p.diskWrite.toFixed(1)} MB/s</td>
            `;
        }
        
        if (settings.showProcessGPU) {
            row += `
                <td class="cpu-cell" style="background: ${getCPUColor(p.gpu)}">${p.gpu.toFixed(1)}%</td>
                <td class="memory-cell" style="background: ${getMemoryColor(p.vram)}">${p.vram.toFixed(0)} MB</td>
            `;
        }
        
        row += `
                <td>${p.user}</td>
            </tr>
        `;
        return row;
    }).join('');
    
    const btn = document.getElementById('kill-selected-btn');
    if (btn) btn.disabled = !selectedPID;
    
    tbody.querySelectorAll('tr').forEach(tr => {
        tr.addEventListener('contextmenu', handleContextMenu);
        tr.addEventListener('click', () => {
            selectedPID = parseInt(tr.dataset.pid);
            renderProcessTable();
        });
    });
}

function handleContextMenu(e) {
    e.preventDefault();
    selectedPID = parseInt(e.currentTarget.dataset.pid);
    renderProcessTable();
    const menu = document.getElementById('context-menu');
    menu.style.display = 'block';
    
    // Get window dimensions
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const menuWidth = 180;
    const menuHeight = 250;
    
    // Calculate position to keep menu in viewport
    let left = e.pageX;
    let top = e.pageY;
    
    if (left + menuWidth > windowWidth) {
        left = windowWidth - menuWidth - 10;
    }
    
    if (top + menuHeight > windowHeight) {
        top = windowHeight - menuHeight - 10;
    }
    
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
}

// Event Listeners
document.addEventListener('click', () => document.getElementById('context-menu').style.display = 'none');
document.getElementById('kill-selected-btn').addEventListener('click', () => { if (selectedPID) killProcess(selectedPID); });
document.getElementById('kill-process').addEventListener('click', () => { if (selectedPID) killProcess(selectedPID); });

document.getElementById('schedule-process').addEventListener('click', () => {
    if (!selectedPID) return;
    const proc = processes.find(p => p.pid === selectedPID);
    if (proc) {
        // Load user list for schedule modal
        exec("cut -d: -f1 /etc/passwd | sort", (err, stdout) => {
            const sel = document.getElementById('schedule-user');
            if (!err && stdout) {
                const users = stdout.trim().split('\n');
                sel.innerHTML = users.map(u => `<option value="${u}">${u}</option>`).join('');
                const curr = os.userInfo().username;
                sel.value = curr;
            }
        });
        document.getElementById('schedule-command').value = proc.fullCommand;
        document.getElementById('schedule-modal').classList.add('show');
    }
});

document.getElementById('schedule-cancel').addEventListener('click', () => {
    document.getElementById('schedule-modal').classList.remove('show');
});

document.getElementById('schedule-confirm').addEventListener('click', () => {
    const user = document.getElementById('schedule-user').value;
    const cmd = document.getElementById('schedule-command').value;
    const min = document.getElementById('schedule-minute').value || '*';
    const hr = document.getElementById('schedule-hour').value || '*';
    const day = document.getElementById('schedule-day').value || '*';
    const mon = document.getElementById('schedule-month').value || '*';
    const dow = document.getElementById('schedule-dow').value || '*';
    const cronLine = `${min} ${hr} ${day} ${mon} ${dow} ${cmd}`;
    exec(`(sudo crontab -u ${user} -l 2>/dev/null; echo "${cronLine}") | sudo crontab -u ${user} -`, (err) => {
        alert(err ? `Failed: ${err.message}` : `Scheduled for user ${user}!\n\n${cronLine}`);
        if (!err) document.getElementById('schedule-modal').classList.remove('show');
    });
});

document.getElementById('startup-process').addEventListener('click', () => {
    if (!selectedPID) return;
    const proc = processes.find(p => p.pid === selectedPID);
    if (proc) {
        const entry = `[Desktop Entry]\nType=Application\nName=${proc.name}\nExec=${proc.fullCommand}\nTerminal=false\nX-GNOME-Autostart-enabled=true`;
        const dir = os.homedir() + '/.config/autostart';
        const file = `${dir}/${proc.name}-${Date.now()}.desktop`;
        exec(`mkdir -p "${dir}"`, (err) => {
            if (err) return alert(`Failed: ${err.message}`);
            fs.writeFile(file, entry, (err) => {
                alert(err ? `Failed: ${err.message}` : `Added ${proc.name} to startup!`);
                if (!err) loadStartupApps();
            });
        });
    }
});

document.getElementById('view-files').addEventListener('click', () => {
    if (!selectedPID) return;
    document.getElementById('files-pid').textContent = selectedPID;
    document.getElementById('files-modal').classList.add('show');
    document.getElementById('file-list').innerHTML = '<p>Loading...</p>';
    exec(`lsof -p ${selectedPID} 2>/dev/null`, (err, stdout) => {
        const list = document.getElementById('file-list');
        if (err || !stdout) return list.innerHTML = '<p>No files found or insufficient permissions.</p>';
        const lines = stdout.trim().split('\n').slice(1);
        if (lines.length === 0) return list.innerHTML = '<p>No open files found.</p>';
        list.innerHTML = lines.map(line => {
            const file = line.trim().split(/\s+/).slice(8).join(' ');
            return `<div class="file-item">${file}</div>`;
        }).join('');
    });
});

document.getElementById('files-close').addEventListener('click', () => {
    document.getElementById('files-modal').classList.remove('show');
});

document.getElementById('view-connections').addEventListener('click', () => {
    if (!selectedPID) return;
    document.getElementById('connections-pid').textContent = selectedPID;
    document.getElementById('connections-modal').classList.add('show');
    document.getElementById('connections-list').innerHTML = '<p>Loading...</p>';
    exec(`lsof -i -a -p ${selectedPID} 2>/dev/null`, (err, stdout) => {
        const list = document.getElementById('connections-list');
        if (err || !stdout) return list.innerHTML = '<p>No connections found.</p>';
        const lines = stdout.trim().split('\n').slice(1);
        if (lines.length === 0) return list.innerHTML = '<p>No active connections.</p>';
        list.innerHTML = lines.map(line => {
            const conn = line.trim().split(/\s+/).slice(8).join(' ');
            return `<div class="file-item">${conn}</div>`;
        }).join('');
    });
});

document.getElementById('connections-close').addEventListener('click', () => {
    document.getElementById('connections-modal').classList.remove('show');
});

document.getElementById('limit-resources').addEventListener('click', () => {
    if (!selectedPID) return;
    document.getElementById('limits-pid').textContent = selectedPID;
    document.getElementById('limits-modal').classList.add('show');
});

document.getElementById('limits-cancel').addEventListener('click', () => {
    document.getElementById('limits-modal').classList.remove('show');
});

document.getElementById('limits-confirm').addEventListener('click', () => {
    const pid = selectedPID;
    const cpuLim = parseInt(document.getElementById('limit-cpu').value) || 0;
    const downLim = parseInt(document.getElementById('limit-download').value) || 0;
    const upLim = parseInt(document.getElementById('limit-upload').value) || 0;
    let cmds = [];
    const cgroup = `taskmgr_${pid}`;
    if (cpuLim > 0) {
        const quota = cpuLim * 100000;
        cmds.push(`sudo mkdir -p /sys/fs/cgroup/${cgroup}`);
        cmds.push(`echo ${quota} | sudo tee /sys/fs/cgroup/${cgroup}/cpu.max`);
        cmds.push(`echo ${pid} | sudo tee /sys/fs/cgroup/${cgroup}/cgroup.procs`);
    }
    if (downLim > 0 || upLim > 0) {
        const iface = 'eth0';
        if (downLim > 0) {
            cmds.push(`sudo tc qdisc add dev ${iface} root handle 1: htb default 10`);
            cmds.push(`sudo tc class add dev ${iface} parent 1: classid 1:1 htb rate ${downLim}kbit`);
            cmds.push(`sudo tc filter add dev ${iface} protocol ip parent 1:0 prio 1 u32 match ip dst 0.0.0.0/0 flowid 1:1`);
        }
    }
    if (cmds.length === 0) return alert('Specify at least one limit.');
    exec(cmds.join(' && '), (err) => {
        alert(err ? `Failed: ${err.message}\n\nRequires root.` : 'Limits applied!');
        if (!err) document.getElementById('limits-modal').classList.remove('show');
    });
});

document.getElementById('process-details').addEventListener('click', () => {
    if (!selectedPID) return;
    const p = processes.find(x => x.pid === selectedPID);
    if (p) alert(`PID: ${p.pid}\nName: ${p.name}\nCommand: ${p.fullCommand}\nCPU: ${p.cpu}%\nMemory: ${p.memoryMB.toFixed(1)} MB\nDisk Read: ${p.diskRead.toFixed(1)} MB/s\nDisk Write: ${p.diskWrite.toFixed(1)} MB/s\nGPU: ${p.gpu.toFixed(1)}%\nVRAM: ${p.vram.toFixed(0)} MB\nUser: ${p.user}`);
});

document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (sortColumn === col) sortDirection *= -1;
        else { sortColumn = col; sortDirection = -1; }
        sortProcesses();
        renderProcessTable();
    });
});

document.getElementById('process-search').addEventListener('input', applySearch);

// View switching
document.querySelectorAll('.sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
        document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        const view = item.dataset.view;
        document.getElementById('processes-view').classList.toggle('hidden', view !== 'processes');
        document.getElementById('performance-view').classList.toggle('hidden', view !== 'performance');
        document.getElementById('startup-view').classList.toggle('hidden', view !== 'startup');
        document.getElementById('crontab-view').classList.toggle('hidden', view !== 'crontab');
        document.getElementById('services-view').classList.toggle('hidden', view !== 'services');
        document.getElementById('logs-view').classList.toggle('hidden', view !== 'logs');
        document.getElementById('network-view').classList.toggle('hidden', view !== 'network');
        document.getElementById('disk-io-view').classList.toggle('hidden', view !== 'disk-io');
        document.getElementById('users-view').classList.toggle('hidden', view !== 'users');
        document.getElementById('sysinfo-view').classList.toggle('hidden', view !== 'sysinfo');
        document.getElementById('settings-view').classList.toggle('hidden', view !== 'settings');
        
        if (view === 'performance') {setTimeout(() => initCharts(), 100);currentview='performance';}
        else if (view === 'startup') {loadStartupApps();currentview='startup';}
        else if (view === 'crontab') {loadUsers();currentview='crontab';}
        else if (view === 'services') {loadServices();currentview='services';}
        else if (view === 'logs') {loadSystemLogs();currentview='logs';}
        else if (view === 'network') {loadNetworkConnections();currentview='network';}
        else if (view === 'disk-io') {loadDiskIO();currentview='disk-io';}
        else if (view === 'users') {loadLoggedInUsers();currentview='users';}
        else if (view === 'sysinfo') {loadSystemInfo();currentview='sysinfo';}
        else if (view === 'settings') {loadSettings();currentview='settings';}
        else {
            // Stop disk IO interval when leaving that view
            if (diskIOInterval) {
                clearInterval(diskIOInterval);
                diskIOInterval = null;
            }
            // Stop network monitoring when leaving that view
            if (networkMonitorInterval) {
                clearInterval(networkMonitorInterval);
                networkMonitorInterval = null;
            }
        }
    });
});

// Startup Apps
function loadStartupApps() {
    const list = document.getElementById('startup-list');
    list.innerHTML = '<p style="text-align: center; padding: 20px;">Loading...</p>';
    const location = document.getElementById('startup-location-select').value;
    const dir = location === 'user' ? os.homedir() + '/.config/autostart' : '/etc/xdg/autostart';
    const useUser = location === 'user';
    
    // Create user directory if it doesn't exist
    if (useUser) {
        exec(`mkdir -p "${dir}"`, () => {});
    }
    
    const findCmd = useUser 
        ? `find "${dir}" -name '*.desktop' 2>/dev/null`
        : `find "${dir}" -name '*.desktop' 2>/dev/null`;
    
    exec(findCmd, (err, stdout) => {
        if (err || !stdout.trim()) return list.innerHTML = '<p style="text-align: center; padding: 20px;">No startup apps.</p>';
        const files = stdout.trim().split('\n').filter(f => f);
        if (files.length === 0) return list.innerHTML = '<p style="text-align: center; padding: 20px;">No startup apps.</p>';
        let html = '', done = 0;
        
        files.forEach(file => {
            const readCmd = `cat "${file}"`;
            exec(readCmd, (err, content) => {
                done++;
                if (!err && content) {
                    const nameMatch = content.match(/Name=(.+)/);
                    const execMatch = content.match(/Exec=(.+)/);
                    const name = nameMatch ? nameMatch[1] : file.split('/').pop();
                    const cmd = execMatch ? execMatch[1] : 'Unknown';
                    html += `<div class="startup-item"><div class="startup-item-info"><div class="startup-item-name">${name}</div><div class="startup-item-command">${cmd}</div></div><button class="btn btn-danger btn-small" onclick="removeStartupApp('${file.replace(/'/g, "\\'")}', ${!useUser})">Remove</button></div>`;
                }
                if (done === files.length) list.innerHTML = html || '<p style="text-align: center; padding: 20px;">No startup apps.</p>';
            });
        });
    });
}

document.getElementById('startup-location-select').addEventListener('change', loadStartupApps);

window.removeStartupApp = function(file, needsSudo) {
    if (!confirm('Remove startup app?')) return;
    const cmd = needsSudo ? `sudo rm "${file}"` : `rm "${file}"`;
    exec(cmd, (err) => {
        alert(err ? `Failed: ${err.message}` : 'Removed!');
        if (!err) loadStartupApps();
    });
};

// Cron Jobs
function loadUsers() {
    exec("cut -d: -f1 /etc/passwd | sort", (err, stdout) => {
        const sel = document.getElementById('cron-user-select');
        if (err || !stdout) return sel.innerHTML = '<option value="">No users</option>';
        const users = stdout.trim().split('\n');
        sel.innerHTML = users.map(u => `<option value="${u}">${u}</option>`).join('');
        const curr = os.userInfo().username;
        sel.value = curr;
        loadCrontab(curr);
    });
}

document.getElementById('cron-user-select').addEventListener('change', (e) => loadCrontab(e.target.value));

function loadCrontab(user) {
    const list = document.getElementById('cron-list');
    list.innerHTML = '<p style="text-align: center; padding: 20px;">Loading...</p>';
    exec(`crontab -u ${user} -l 2>/dev/null`, (err, stdout) => {
        if (err || !stdout) return list.innerHTML = '<p style="text-align: center; padding: 20px;">No cron jobs.</p>';
        const lines = stdout.trim().split('\n').filter(l => l && !l.startsWith('#'));
        if (lines.length === 0) return list.innerHTML = '<p style="text-align: center; padding: 20px;">No cron jobs.</p>';
        list.innerHTML = lines.map((line, idx) => {
            const parts = line.split(/\s+/);
            const sched = parts.slice(0, 5).join(' ');
            const cmd = parts.slice(5).join(' ');
            return `<div class="cron-item"><div class="cron-item-info"><div class="cron-item-schedule">${sched}</div><div class="cron-item-command">${cmd}</div></div><button class="btn btn-danger btn-small" onclick="removeCronJob('${user}', ${idx})">Remove</button></div>`;
        }).join('');
    });
}

window.removeCronJob = function(user, idx) {
    if (!confirm('Remove cron job?')) return;
    exec(`crontab -u ${user} -l 2>/dev/null`, (err, stdout) => {
        if (err) return alert('Failed to load crontab');
        const lines = stdout.trim().split('\n').filter(l => l && !l.startsWith('#'));
        lines.splice(idx, 1);
        exec(`echo "${lines.join('\n')}" | crontab -u ${user} -`, (err) => {
            alert(err ? `Failed: ${err.message}` : 'Removed!');
            if (!err) loadCrontab(user);
        });
    });
};

// Services
function loadServices() {
    const list = document.getElementById('services-list');
    const container = list.parentElement;
    currentServiceScrollPos = container.scrollTop;
    list.innerHTML = '<p style="text-align: center; padding: 20px;">Loading...</p>';
    exec("systemctl list-units --type=service --all --no-pager --plain", (err, stdout) => {
        if (err || !stdout) return list.innerHTML = '<p style="text-align: center; padding: 20px;">Failed to load.</p>';
        exec("systemctl list-unit-files --type=service --no-pager | grep -E 'enabled|disabled'", (err2, stdout2) => {
            if (!err2 && stdout2) {
                stdout2.trim().split('\n').forEach(line => {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 2) serviceStates[parts[0]] = parts[1];
                });
            }
            const lines = stdout.trim().split('\n').slice(1);
            allServices = lines.map(line => {
                const match = line.match(/^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
                return match ? { name: match[1], load: match[2], active: match[3], sub: match[4], description: match[5] } : null;
            }).filter(s => s && s.name);
            applyServiceFilters();
            setTimeout(() => container.scrollTop = currentServiceScrollPos, 50);
        });
    });
}

document.getElementById('service-search').addEventListener('input', applyServiceFilters);
document.getElementById('service-filter').addEventListener('change', applyServiceFilters);
document.getElementById('service-sort').addEventListener('change', applyServiceFilters);

function applyServiceFilters() {
    const term = document.getElementById('service-search').value.toLowerCase();
    const filter = document.getElementById('service-filter').value;
    const sort = document.getElementById('service-sort').value;
    
    let filtered = allServices.filter(s => s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term));
    
    if (filter === 'running') filtered = filtered.filter(s => s.active === 'active');
    else if (filter === 'enabled') filtered = filtered.filter(s => serviceStates[s.name] === 'enabled');
    else if (filter === 'disabled') filtered = filtered.filter(s => serviceStates[s.name] === 'disabled');
    
    if (sort === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'status') filtered.sort((a, b) => {
        if (a.active === b.active) return a.name.localeCompare(b.name);
        return a.active === 'active' ? -1 : 1;
    });
    
    renderServices(filtered);
}

function renderServices(services) {
    const list = document.getElementById('services-list');
    if (services.length === 0) return list.innerHTML = '<p style="text-align: center; padding: 20px;">No services found.</p>';
    list.innerHTML = services.map(s => {
        const status = s.active === 'active' ? 'active' : s.active === 'failed' ? 'failed' : 'inactive';
        const isEnabled = serviceStates[s.name] === 'enabled';
        const enableClass = isEnabled ? 'enabled' : 'disabled';
        return `<div class="service-item"><div class="service-item-info"><div class="service-item-name">${s.name}</div><div class="service-item-status ${status}">${s.active} • ${s.sub}</div><div class="cron-item-command">${s.description}</div></div><div class="service-actions"><button class="btn btn-small" onclick="serviceAction('start', '${s.name}')">Start</button><button class="btn btn-small" onclick="serviceAction('stop', '${s.name}')">Stop</button><button class="btn btn-small" onclick="serviceAction('restart', '${s.name}')">Restart</button><button class="btn btn-small ${enableClass}" onclick="serviceAction('${isEnabled ? 'disable' : 'enable'}', '${s.name}')">${isEnabled ? 'Disable' : 'Enable'}</button></div></div>`;
    }).join('');
}

window.serviceAction = function(action, name) {
    if (!confirm(`${action} ${name}?`)) return;
    const container = document.getElementById('services-list').parentElement;
    currentServiceScrollPos = container.scrollTop;
    exec(`sudo systemctl ${action} ${name}`, (err, stdout, stderr) => {
        alert(err ? `Failed: ${stderr || err.message}` : `${action}ed ${name}`);
        if (!err) setTimeout(() => loadServices(), 300);
    });
};

// System Logs
function loadSystemLogs() {
    const list = document.getElementById('logs-list');
    list.innerHTML = '<p style="text-align: center; padding: 20px;">Loading...</p>';
    exec("journalctl -n 100 --no-pager -o json", (err, stdout) => {
        if (err || !stdout) return list.innerHTML = '<p style="text-align: center; padding: 20px;">Failed to load logs.</p>';
        const lines = stdout.trim().split('\n').filter(l => l);
        const logs = lines.map(line => {
            try { return JSON.parse(line); } catch (e) { return null; }
        }).filter(l => l).reverse();
        if (logs.length === 0) return list.innerHTML = '<p style="text-align: center; padding: 20px;">No logs found.</p>';
        list.innerHTML = logs.map((log, idx) => {
            const app = log.SYSLOG_IDENTIFIER || log._COMM || 'unknown';
            const msg = log.MESSAGE || '';
            const time = log.__REALTIME_TIMESTAMP ? new Date(parseInt(log.__REALTIME_TIMESTAMP) / 1000).toLocaleString() : 'N/A';
            return `<div class="log-entry" data-idx="${idx}"><div class="log-entry-header"><span class="log-entry-app">${app}</span><span class="log-entry-time">${time}</span></div><div class="log-entry-message">${msg.substring(0, 100)}</div></div>`;
        }).join('');
        document.querySelectorAll('.log-entry').forEach(entry => {
            entry.addEventListener('click', () => {
                document.querySelectorAll('.log-entry').forEach(e => e.classList.remove('selected'));
                entry.classList.add('selected');
                const idx = parseInt(entry.dataset.idx);
                const log = logs[idx];
                const details = document.getElementById('log-details');
                details.style.display = 'block';
                details.textContent = JSON.stringify(log, null, 2);
            });
        });
    });
}
document.getElementById('network-mode-select').addEventListener('click', ()=>{
    loadNetworkConnections();
});
// Network Connections
function loadNetworkConnections() {
    const mode = document.getElementById('network-mode-select').value;
    const list = document.getElementById('network-list');
    
    // Stop any existing monitoring interval
    if (networkMonitorInterval) {
        clearInterval(networkMonitorInterval);
        networkMonitorInterval = null;
    }
    
    list.innerHTML = '<p style="text-align: center; padding: 20px;">Loading...</p>';
    
    if (mode === 'connections') {
        exec("ss -tupn 2>/dev/null || ss -tun", (err, stdout) => {
            if (err || !stdout) return list.innerHTML = '<p style="text-align: center; padding: 20px;">Failed to load.</p>';
            const lines = stdout.trim().split('\n').slice(1);
            if (lines.length === 0) return list.innerHTML = '<p style="text-align: center; padding: 20px;">No connections found.</p>';
            list.innerHTML = lines.map(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 5) return '';
                const proto = parts[0], state = parts[1], local = parts[4], peer = parts[5];
                const process = parts[6] || 'N/A';
                return `<div class="network-entry"><div class="network-entry-header"><span>${proto}</span><span>${state}</span></div><div class="network-entry-details">Local: ${local} → Peer: ${peer}<br>Process: ${process}</div></div>`;
            }).join('');
        });
    } else if (mode === 'process') 
    {
      function updateNetworkByProcess(list) 
      {     
        //console.log("Networking....");
        if (!list) return;
        exec("sudo nethogs -t -c 2 2>&1", (err, stdout, stderr) => 
        {
        // Permission errors
        if (stderr && (stderr.includes("Permission denied") ||
                    stderr.includes("Operation not permitted") ||
                    stderr.includes("must be root"))) 
        {
            list.innerHTML = `
            <p style="text-align:center; padding:20px;">
            Run app with sudo for network per-process monitoring:<br><br>
            <code>sudo nw .</code>
            </p>`;
            return;
        }
        if (!stdout || !stdout.trim()) 
        {
            list.innerHTML = `<p style="text-align:center; padding:20px;">
                Waiting for network traffic...
            </p>`;
            return;
        }
        const lines = stdout.split("\n");
        const processMap = {};

        for (const raw of lines) 
        {
            let line = raw.trim();
            if (!line || line.startsWith("Refreshing:") || line.startsWith("Adding") || line.startsWith("Ethernet")) {continue;}       

            // Split line into parts; last two are sent & recv, rest is process name
            const parts = line.split(/\s+/);
            if (parts.length < 3) continue;

            // Sometimes numbers are concatenated (like 0.2580080.496484), try to split
            let sent = parseFloat(parts[parts.length - 2]);
            let recv = parseFloat(parts[parts.length - 1]);
            if (isNaN(sent) || isNaN(recv)) {
                // Attempt to split concatenated numbers
                const combined = parts[parts.length - 2] + parts[parts.length - 1];
                const nums = combined.match(/[\d.]+/g);
                if (nums && nums.length >= 2) {
                sent = parseFloat(nums[0]);
                recv = parseFloat(nums[1]);
                } else {
                continue; // skip line if parsing fails
                }
            }

            const proc = parts.slice(0, parts.length - 2).join(" ");

            if (!processMap[proc]) processMap[proc] = { sent: 0, recv: 0 };
            processMap[proc].sent += sent;
            processMap[proc].recv += recv;
        }

        const entries = Object.entries(processMap);
        if (entries.length === 0) 
        {
            list.innerHTML = `<p style="text-align:center; padding:20px;">
                No network traffic detected. Monitoring...
            </p>`;
            return;
        }

        let html = "";
        for (const [proc, data] of entries) 
        {
        html += `
            <div class="network-entry">
            <div class="network-entry-header">
                <span style="font-family:monospace; word-break:break-all;">${proc}</span>
            </div>
            <div class="network-entry-details">
                ↓ ${data.recv.toFixed(3)} KB/s | ↑ ${data.sent.toFixed(3)} KB/s
            </div>
            </div>`;
        }

        list.innerHTML = html;

        /*    // Optional: debug log
            console.table(entries.map(([proc, d]) => ({
            process: proc,
            upload_kbs: d.sent.toFixed(3),
            download_kbs: d.recv.toFixed(3)
            }))); */
    
        });
    }

// Example usage:
const list = document.getElementById("network-list");
list.innerHTML = '<p style="text-align: center; padding: 20px;">Starting nethogs monitoring...<br><small>Requires sudo privileges</small></p>';

// Poll every 4 seconds
updateNetworkByProcess(list);
networkMonitorInterval = setInterval(() => ()=>{if(currentview ==='network') {updateNetworkByProcess(list);}}, 4000);
        
    } else if (mode === 'address') {
        list.innerHTML = '<div style="padding: 15px;"><table style="width: 100%; border-collapse: collapse;text-align-last: center;"><thead><tr style="background: #2d2d30; border-bottom: 2px solid #3e3e42;"><th style="padding: 10px; text-align: left;">Host</th><th style="padding: 10px; text-align: left;">Remote Address</th><th style="padding: 10px; text-align: right;">Upload</th><th style="padding: 10px; text-align: right;">Download</th></tr></thead><tbody id="iftop-tbody"><tr><td colspan="4" style="text-align: center; padding: 20px;">Starting monitoring...</td></tr></tbody></table></div>';
        
        // Use polling for real-time updates
function updateNetworkByAddress() {
    //console.log("Networking....");
  exec("iftop -t -p -s 1 -B 2>&1", (err, stdout, stderr) => {
    const tbody = document.getElementById("iftop-tbody");
    if (!tbody) return;

    if (!stdout || !stdout.trim()) {
      tbody.innerHTML =
        '<tr><td colspan="5" style="text-align:center;">Waiting for network traffic...</td></tr>';
      return;
    }

    const lines = stdout.split("\n");
    const connections = [];
    let lastUpload = null;

    const parseRate = (s) => {
      if (!s) return 0;
      const v = parseFloat(s);
      if (s.includes("MB")) return v * 1024;
      if (s.includes("Mb")) return v * 128;      // 1024/8
      if (s.includes("KB")) return v;
      if (s.includes("Kb")) return v / 8;
      if (s.includes("B"))  return v / 1024;
      return v;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Outgoing line
      if (/=>/.test(line)) {
        const parts = line.split(/\s+/);
        const host = parts[0];
        const rateStr = parts[parts.length - 4];  // first numeric after the arrow (last 2s)
        lastUpload = {
          local: os.hostname(),
          remote: null,
          upload: parseRate(rateStr),
          download: 0,
        };
      }
      // Incoming line
      else if (/<=/.test(line)) {
        const parts = line.split(/\s+/);
        const host = parts[0];
        const rateStr = parts[parts.length - 4];
        if (lastUpload) {
          lastUpload.remote = host;
          lastUpload.download = parseRate(rateStr);
          connections.push(lastUpload);
          lastUpload = null;
        } else {
          connections.push({
            local: os.hostname(),
            remote: host,
            upload: 0,
            download: parseRate(rateStr),
          });
        }
      }
    }

    if (connections.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" style="text-align:center;">No active connections.</td></tr>';
      return;
    }

    tbody.innerHTML = connections
      .map(
        (conn) => `
          <tr>
            <td >${conn.local}</td>
            <td>${conn.remote || "?"}</td>
            <td style="color:green;">↑ ${conn.upload.toFixed(2)} KB/s</td>
            <td style="color:blue;">↓ ${conn.download.toFixed(2)} KB/s</td>
          </tr>`
      )
      .join("");

    // Optional: also log to console for debugging
    console.table(connections);
  });

}   
        updateNetworkByAddress();
        networkMonitorInterval = setInterval(()=>{if(currentview ==='network') {updateNetworkByAddress();}}, 2000);
    }
}

document.getElementById('refresh-network').addEventListener('click', () => {
    if (networkMonitorInterval) {
        clearInterval(networkMonitorInterval);
        networkMonitorInterval = null;
    }
    loadNetworkConnections();
});

// Disk I/O
function loadDiskIO() {
    const tbody = document.getElementById('diskio-tbody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 40px;">Loading...</td></tr>';
    
    // Stop if already running
    if (diskIOInterval) clearInterval(diskIOInterval);
    
    function updateDiskIO() {
        //console.log("Disk usage....");
        getProcessDiskIO((ioData) => {
            exec("ps aux | awk '{print $2, $11}'", (err, stdout) => {
                if (err) return;
                const processNames = {};
                stdout.trim().split('\n').forEach(line => {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 2) {
                        const pid = parseInt(parts[0]);
                        let name = parts[1];
                        if (name.includes('/')) name = name.split('/').pop();
                        name = name.replace(/\.bin$/, '').replace(/\.exe$/, '');
                        processNames[pid] = name;
                    }
                });
                
                const ioProcs = Object.keys(ioData).map(pid => ({
                    pid: parseInt(pid),
                    name: processNames[pid] || 'unknown',
                    readMBs: ioData[pid].readMBs,
                    writeMBs: ioData[pid].writeMBs,
                    total: ioData[pid].total
                })).filter(p => p.total > 0.001).sort((a, b) => b.total - a.total).slice(0, 50);
                
                if (ioProcs.length === 0) {
                    return tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 40px;">No significant disk I/O detected</td></tr>';
                }
                
                tbody.innerHTML = ioProcs.map(p => `
                    <tr>
                        <td>${p.pid}</td>
                        <td>${p.name}</td>
                        <td>${p.readMBs.toFixed(2)} MB/s</td>
                        <td>${p.writeMBs.toFixed(2)} MB/s</td>
                        <td>${p.total.toFixed(2)} MB/s</td>
                    </tr>
                `).join('');
            });
        });
}        
    updateDiskIO();
    diskIOInterval = setInterval(()=>{if(currentview ==='disk-io') {updateDiskIO();}}, 2000);

}

document.getElementById('refresh-diskio').addEventListener('click', loadDiskIO);

// Logged In Users
function loadLoggedInUsers() {
    const list = document.getElementById('users-list');
    list.innerHTML = '<p style="text-align: center; padding: 20px;">Loading...</p>';
    
    exec("w -h", (err, stdout) => {
        if (err || !stdout) return list.innerHTML = '<p style="text-align: center; padding: 20px;">Failed to load users.</p>';
        
        const users = {};
        stdout.trim().split('\n').forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3) {
                const username = parts[0];
                const tty = parts[1];
                const from = parts[2];
                if (!users[username]) users[username] = { sessions: [] };
                users[username].sessions.push({ tty, from });
            }
        });
        
        if (Object.keys(users).length === 0) {
            return list.innerHTML = '<p style="text-align: center; padding: 20px;">No users currently logged in.</p>';
        }
        
        let html = '';
        for (const [user, data] of Object.entries(users)) {
            const sessionInfo = data.sessions.map(s => `${s.tty} (${s.from})`).join(', ');
            html += `<div class="startup-item"><div class="startup-item-info"><div class="startup-item-name">${user}</div><div class="startup-item-command">Sessions: ${data.sessions.length} | ${sessionInfo}</div></div></div>`;
        }
        list.innerHTML = html || '<p style="text-align: center; padding: 20px;">No users found.</p>';
    });
}

// System Info
function loadSystemInfo() {
    const content = document.getElementById('sysinfo-content');
    content.innerHTML = '<p style="text-align: center; padding: 40px;">Loading...</p>';
    
    Promise.all([
        new Promise(resolve => exec("hostname", (err, stdout) => resolve({ title: 'Hostname', value: stdout.trim() || 'N/A' }))),
        new Promise(resolve => exec("cat /etc/os-release | grep '^PRETTY_NAME=' | cut -d'=' -f2 | tr -d '\"'", (err, stdout) => resolve({ title: 'OS', value: stdout.trim() || 'N/A' }))),
        new Promise(resolve => exec("uname -r", (err, stdout) => resolve({ title: 'Kernel', value: stdout.trim() || 'N/A' }))),
        new Promise(resolve => exec("uname -m", (err, stdout) => resolve({ title: 'Architecture', value: stdout.trim() || 'N/A' }))),
        new Promise(resolve => {
            exec("echo $XDG_SESSION_TYPE", (err, stdout) => {
                let sessionType = stdout.trim() || 'N/A';
                if (sessionType === 'N/A' || sessionType === '') {
                    exec("loginctl show-session $(loginctl | grep $(whoami) | awk '{print $1}' | head -1) -p Type --value", (err2, stdout2) => {
                        sessionType = stdout2.trim() || 'N/A';
                        resolve({ title: 'Session Type', value: sessionType });
                    });
                } else {
                    resolve({ title: 'Session Type', value: sessionType });
                }
            });
        }),
        new Promise(resolve => exec("echo $XDG_CURRENT_DESKTOP", (err, stdout) => resolve({ title: 'Desktop', value: stdout.trim() || 'N/A' }))),
        new Promise(resolve => {
            exec("cat /etc/X11/default-display-manager 2>/dev/null | xargs basename", (err, stdout) => {
                let dm = stdout.trim();
                if (!dm || err) {
                    exec("systemctl list-units --type=service --state=running | grep -E 'gdm|sddm|lightdm|lxdm|xdm|kdm' | awk '{print $1}' | head -1 | sed 's/.service//'", (err2, stdout2) => {
                        dm = stdout2.trim() || 'N/A';
                        resolve({ title: 'Display Manager', value: dm });
                    });
                } else {
                    resolve({ title: 'Display Manager', value: dm });
                }
            });
        }),
        new Promise(resolve => exec("cat /sys/devices/virtual/dmi/id/product_name 2>/dev/null || echo 'N/A'", (err, stdout) => resolve({ title: 'Model', value: stdout.trim() || 'N/A' }))),
        new Promise(resolve => exec("uptime -p", (err, stdout) => resolve({ title: 'Uptime', value: stdout.replace('up ', '').trim() || 'N/A' }))),
        new Promise(resolve => exec("lscpu | grep 'Model name' | cut -d':' -f2 | xargs", (err, stdout) => resolve({ title: 'CPU', value: stdout.trim() || 'N/A' }))),
        new Promise(resolve => exec("nproc", (err, stdout) => resolve({ title: 'CPU Cores', value: stdout.trim() || 'N/A' }))),
        new Promise(resolve => exec("free -h | grep Mem | awk '{print $2}'", (err, stdout) => resolve({ title: 'RAM', value: stdout.trim() || 'N/A' }))),
        new Promise(resolve => exec("df -h / | tail -1 | awk '{print $2}'", (err, stdout) => resolve({ title: 'Disk Size', value: stdout.trim() || 'N/A' }))),
        new Promise(resolve => exec("hostname -I | awk '{print $1}'", (err, stdout) => resolve({ title: 'IP Address', value: stdout.trim() || 'N/A' }))),
    ]).then(results => {
        content.innerHTML = results.map(item => `
            <div class="info-card">
                <div class="info-label">${item.title}</div>
                <div class="info-value">${item.value}</div>
            </div>
        `).join('');
    });
}

// Settings
function loadSettings() {
    document.getElementById('setting-process-diskio').checked = settings.showProcessDiskIO;
    document.getElementById('setting-process-gpu').checked = settings.showProcessGPU;
}

function saveSettings() {
    settings.showProcessDiskIO = document.getElementById('setting-process-diskio').checked;
    settings.showProcessGPU = document.getElementById('setting-process-gpu').checked;
    
    // Save to localStorage
    try {
        localStorage.setItem('elve-monitor-settings', JSON.stringify(settings));
    } catch (e) {
        console.log('Could not save settings:', e);
    }
    
    alert('Settings saved! Refreshing processes...');
    refreshProcesses();
}

document.getElementById('save-settings')?.addEventListener('click', saveSettings);

// Window visibility handling
window.addEventListener('resize', () => {
    if (!document.getElementById('performance-view').classList.contains('hidden')) initCharts();
});

try {
    const nw_win = nw.Window.get();
    nw_win.on('minimize', () => { isWindowVisible = false; console.log('Paused'); });
    nw_win.on('restore', () => { isWindowVisible = true; console.log('Resumed'); updateSystemStats(); refreshProcesses(); });
    nw_win.on('focus', () => { isWindowVisible = true; });
} catch (e) {
    console.log('NW.js events not available:', e);
}
// Initialize
updateSystemStats();
refreshProcesses();
updateIntervals.push(setInterval(() => { if (isWindowVisible) refreshProcesses(); }, 2000));