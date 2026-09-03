---
title: "你或许不需要 GUI 代理客户端"
summary: "v2rayN 太重了，用 systemd service 和脚本代替它"
date: "2026-09-03"
---

我用 Debian 系统，我之前一直用 v2rayN 做代理客户端，但它太“重”了：每次开机都要手动启动，就算设置开机自启，也会弹出窗口，就算设置不弹出窗口，也会在任务栏显示图标，就算把图标隐藏了，也会比单独的 Xray 内核占用更多内存。

我的需求就是开机自启+线路切换+流量监控。我用自己的 VPS 搭梯子，用不着订阅。

Xray 有 Linux 的一键安装脚本，给系统上的所有用户安装，但我不需要。直接从 [Xray-core 的 releases](https://github.com/XTLS/Xray-core/releases) 下载`Xray-linux-64.zip`，解压到`~/program/Xray`。

## 线路切换

一开始我想用它的 API 做线路切换，但是 gRPC API 太重了，所以用一个主配置文件+多个 outbound 配置文件。

```text
program/Xray/
├── bin
│   ├── geoip.dat
│   ├── geosite.dat
│   ├── LICENSE
│   ├── README.md
│   └── xray
├── conf
│   ├── base.json < 通用配置
│   ├── cdn.json < CDN线路
│   └── xhttp.json < 直连线路
├── route < 配置文件名
└── xray.sh
```

`base.json`:

```json
{
  "inbounds": [
    {
      "tag": "socks",
      "port": 10808,
      "listen": "127.0.0.1",
      "protocol": "mixed",
      "sniffing": {
        "enabled": true,
        "destOverride": ["http","tls"],
        "routeOnly": true
      },
      "settings": {
        "auth": "noauth",
        "udp": true,
        "allowTransparent": false
      }
    },
    {
      "tag": "api",
      "port": 10812,
      "listen": "127.0.0.1",
      "protocol": "dokodemo-door",
      "settings": {
        "address": "127.0.0.1"
      }
    }
  ],
  "outbounds": [
    {
      "tag": "direct",
      "protocol": "freedom"
    },
    {
      "tag": "block",
      "protocol": "blackhole"
    }
  ],
  "routing": {
    "domainStrategy": "IPIfNonMatch",
    "rules": [
      {
        "type": "field",
        "inboundTag": ["api"],
        "outboundTag": "api"
      },
      {
        "type": "field",
        "outboundTag": "direct",
        "ip": ["geoip:private", "geoip:cn"]
      },
      {
        "type": "field",
        "outboundTag": "direct",
        "domain": ["geosite:private", "geosite:cn"]
      }
    ]
  },
  "metrics": {
    "tag": "api"
  },
  "policy": {
    "system": {
      "statsOutboundUplink": true,
      "statsOutboundDownlink": true
    }
  },
  "stats": {}
}
```

除了 inbound ，还写了路由规则，直连局域网地址和国内地址。启用 API 和 stats ，之后的流量统计用得到。

`xhttp.json`:

```json
{
  "outbounds": [
    {
      "tag": "proxy",
      "protocol": "vless",
      "settings": {
        "address": "example.com",
        "port": 443,
        "id": "xxxx",
        "encryption": "none"
      },
      "streamSettings": {
        "network": "xhttp",
        "xhttpSettings": {
            "path": "/xray"
        },
        "security": "tls",
        "tlsSettings": {
        }
      }
    }
  ]
}
```

这里省略`cdn.json`，因为除了地址，别的内容都差不多。

`~/program/Xray/xray.sh`:

```shell
route="$(cat route)"
./bin/xray run -c conf/base.json -c "conf/$route"
```

启动时从`route`文件读取配置文件名称。

`switch-proxy.sh`:

```shell
cat << EOF
Choose one of the routes:
[1]: Direct
[2]: CDN
EOF

# 交互式设置 route
route=xhttp.json
read -p "Choice: " id
if [ "$id" == "1" ]; then
    route=xhttp.json
elif [ "$id" == "2" ]; then
    route=cdn.json
else
    echo "Use default route"
fi

echo -n "$route" > ~/program/Xray/route
echo "Route: $route"
systemctl --user restart xray
echo "Xray core restarted"
```

## 开机自启

用 user 级别的 systemd service 。创建`~/.config/systemd/user/xray.service`

```systemd
[Unit]
Description=Xray core
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/program/Xray/
ExecStart=bash %h/program/Xray/xray.sh

[Install]
WantedBy=default.target
```

启用服务：

```shell
systemctl --user enable xray.service
```

让它在开机时启动：

```shell
loginctl enable-linger
```

## 流量统计

Xray 提供了一个 HTTP 的 API ，用于统计，用不着 gRPC 。这种功能，用 Node.js 是最简单的。

```javascript
function formatBytes(bytes, decimals = 2) { // 从 Stackoverflow 上抄的
    if (!+bytes) return '0 Bytes'
    const k = 1024
    const dm = decimals < 0 ? 0 : decimals
    const sizes = ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

const response = await fetch("http://localhost:10812/debug/vars")
const json = await response.json()
const outbound = json.stats.outbound
console.log({ // Node 打印 object 时有缩进和颜色，好看一些
    proxy: {
        uplink: formatBytes(outbound.proxy.uplink),
        downlink: formatBytes(outbound.proxy.downlink)
    },
    direct: { 
        uplink: formatBytes(outbound.direct.uplink),
        downlink: formatBytes(outbound.direct.downlink)
    }
})
```

在第一行加上`#!/usr/bin/env node`，再`chmod +x stats.js`，就可以直接在命令行中`./stats.js`。（这里不直接把它放到代码块里，因为会影响代码高亮）

## 日志

Xray 的 stdout 会被记录到 journal 里面，可以用这个命令查看连接日志：`journalctl --user -u xray -f -o cat`。`-f`是实时更新，`-o cat`设置输出格式为原始内容。

打印出来是这样的：

```text
2026/09/03 23:40:24.926246 from DNS accepted https://dns.google/dns-query [dns-module -> proxy]
2026/09/03 23:40:26.464586 from tcp:127.0.0.1:47430 accepted tcp:github.com:443 [socks >> proxy]
2026/09/03 23:43:20.517017 from 127.0.0.1:34974 accepted tcp:127.0.0.1:10812 [api -> api]
```

可以看到每个连接的来源和去向。

## 总结

虽然内存占用没有减少很多，但开机的时候完全没有感受，体验好了很多。
