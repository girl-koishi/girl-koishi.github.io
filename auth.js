/**
 * auth.js — 阶序智调 登录鉴权客户端脚本
 * 所有页面在 <head> 中引入: <script src="auth.js"></script>
 * 未登录自动跳转 login.html
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'jxzd_auth_token';
  var LOGIN_PAGE = '/login.html';

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function setToken(token) {
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch (e) {}
  }

  function clearToken() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  function redirectToLogin() {
    clearToken();
    var current = window.location.pathname;
    if (current !== LOGIN_PAGE) {
      window.location.href = LOGIN_PAGE + '?redirect=' + encodeURIComponent(current);
    }
  }

  // 同步快速检查：无 token 立即跳转（避免页面闪现）
  var token = getToken();
  if (!token) {
    redirectToLogin();
    return; // 页面停止加载
  }

  // 异步验证 token 有效性
  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/auth-check', false); // 同步请求，确保验证完成前页面不渲染
  xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  try {
    xhr.send();
    if (xhr.status !== 200) {
      redirectToLogin();
      return;
    }
    var resp = JSON.parse(xhr.responseText);
    if (!resp.valid) {
      redirectToLogin();
      return;
    }
  } catch (e) {
    redirectToLogin();
    return;
  }

  // 暴露全局方法
  window.JXZD_AUTH = {
    token: token,
    username: (function () {
      try { return JSON.parse(xhr.responseText).username || 'admin'; } catch (e) { return 'admin'; }
    })(),
    logout: function () {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/logout', true);
      x.setRequestHeader('Authorization', 'Bearer ' + getToken());
      x.send();
      clearToken();
      window.location.href = LOGIN_PAGE;
    },
    // 给 fetch 请求附加 Authorization 头的辅助方法
    authHeader: function () {
      return { 'Authorization': 'Bearer ' + getToken() };
    },
    // 带 auth 的 fetch 封装
    fetch: function (url, options) {
      options = options || {};
      options.headers = options.headers || {};
      if (typeof options.headers === 'object' && !Array.isArray(options.headers)) {
        options.headers['Authorization'] = 'Bearer ' + getToken();
      }
      return fetch(url, options).then(function (resp) {
        if (resp.status === 401) { redirectToLogin(); }
        return resp;
      });
    }
  };

  // 拦截所有 fetch 请求，自动附加 token
  var originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (url, options) {
      options = options || {};
      options.headers = options.headers || {};
      if (typeof options.headers === 'object' && !Array.isArray(options.headers)) {
        if (!options.headers['Authorization']) {
          options.headers['Authorization'] = 'Bearer ' + getToken();
        }
      }
      return originalFetch.call(this, url, options).then(function (resp) {
        if (resp.status === 401) { redirectToLogin(); }
        return resp;
      });
    };
  }

  // 拦截 XMLHttpRequest，自动附加 token
  var originalOpen = XMLHttpRequest.prototype.open;
  var originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._jxzd_url = url;
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var self = this;
    // 跳过登录相关请求
    if (this._jxzd_url && this._jxzd_url.indexOf('/api/login') === -1 && this._jxzd_url.indexOf('/api/auth-check') === -1) {
      this.setRequestHeader('Authorization', 'Bearer ' + getToken());
    }
    this.addEventListener('load', function () {
      if (self.status === 401) { redirectToLogin(); }
    });
    return originalSend.apply(this, arguments);
  };

  // 注入浮动退出按钮（DOM 加载后执行）
  function injectLogoutButton() {
    if (document.getElementById('jxzd-logout-btn')) return;

    var btn = document.createElement('div');
    btn.id = 'jxzd-logout-btn';
    btn.style.cssText = [
      'position:fixed', 'bottom:16px', 'right:16px', 'z-index:99999',
      'display:flex', 'align-items:center', 'gap:6px',
      'padding:6px 14px', 'font-size:11px', 'font-family:inherit',
      'color:#8ab4d8', 'cursor:pointer', 'user-select:none',
      'background:rgba(8,18,42,.85)', 'border:1px solid rgba(0,210,255,.15)',
      'border-radius:6px', 'backdrop-filter:blur(6px)',
      'transition:.25s', 'white-space:nowrap'
    ].join(';') + ';';

    var userSpan = document.createElement('span');
    userSpan.style.color = '#00d2ff';
    userSpan.textContent = window.JXZD_AUTH.username;
    btn.appendChild(userSpan);

    var sep = document.createElement('span');
    sep.style.opacity = '0.3';
    sep.textContent = '|';
    btn.appendChild(sep);

    var logoutSpan = document.createElement('span');
    logoutSpan.textContent = '退出';
    btn.appendChild(logoutSpan);

    btn.addEventListener('mouseenter', function () {
      btn.style.borderColor = 'rgba(255,61,87,.4)';
      btn.style.color = '#ff3d57';
      btn.style.background = 'rgba(255,61,87,.06)';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.borderColor = 'rgba(0,210,255,.15)';
      btn.style.color = '#8ab4d8';
      btn.style.background = 'rgba(8,18,42,.85)';
    });
    btn.addEventListener('click', function () {
      if (confirm('确定退出登录？')) {
        window.JXZD_AUTH.logout();
      }
    });

    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectLogoutButton);
  } else {
    injectLogoutButton();
  }
})();
