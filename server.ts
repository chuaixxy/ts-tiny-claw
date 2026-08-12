// 启动服务器
console.log("Server is starting on port 8080...")

// TODO: 增加鉴权逻辑
if (user == null) {
  console.log("Forbidden!");
  return;
}
