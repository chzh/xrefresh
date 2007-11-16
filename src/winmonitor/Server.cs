using System;
using System.Collections.Generic;
using System.Drawing;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using Newtonsoft.Json;

namespace XRefresh
{
	// implemented thanks to:
	// http://www.codeguru.com/Csharp/Csharp/cs_network/sockets/article.php/c7695/
	public class Server
	{
		public class ClientMessage
		{
			public string command;
			public string text;
			public string type;
			public string agent;
			public string page;
			public string url;

			public ClientMessage()
			{
			}

			public ClientMessage(string command, string text)
			{
				this.command = command;
				this.text = text;
			}
		}

		public class ServerMessage
		{
			public string command;

			public ServerMessage(string command)
			{
				this.command = command;
			}
		}

		public class ServerMessageAbout : ServerMessage
		{
			public string version;
			public string agent; // implementation specific string e.g. "WinDrum"

			public ServerMessageAbout(string version, string agent)
				: base("AboutMe")
			{
				this.version = version;
				this.agent = agent;
			}
		}

		public class ServerMessageRefresh : ServerMessage
		{
			public class File
			{
				public File(string root, Model.Activity activity)
				{
					action = activity.type.ToString().ToLower();
					path1 = RelativePath(activity.path1, root);
					path2 = RelativePath(activity.path2, root);
				}

				private string RelativePath(string path, string root)
				{
					if (path != null && path.StartsWith(root)) return path.Substring(root.Length).TrimStart('\\');
					return path;
				}

				public string action;
				public string path1;
				public string path2;
			}

			public string date;
			public string time;
			public string root;
			public string name;
			public string type;
			public File[] files;

			public ServerMessageRefresh(Model.FoldersRow folder, bool positive)
				: base("DoRefresh")
			{
				lock (folder.activities)
				{
					DateTime d = DateTime.Now;
					date = d.ToShortDateString();
					time = d.ToLongTimeString();
					root = folder.Path;
					name = folder.Name;

					// <path, most significant activity>
					Dictionary<string, Model.Activity> ops = new Dictionary<string, Model.Activity>();
					while (folder.activities.Count > 0)
					{
						Model.Activity activity = folder.activities.Dequeue();
						if (!positive || activity.passed)
						{
							if (ops.ContainsKey(activity.path1))
							{
								// take more significant activity
								if (activity > ops[activity.path1]) ops[activity.path1] = activity;
							}
							else
							{
								ops.Add(activity.path1, activity);
							}
						}
					}

					files = new File[ops.Count];
					int i = ops.Count;
					foreach (Model.Activity activity in ops.Values)
					{
						i--;
						files[i] = new File(root, activity);
					}
				}
			}

			internal void Log(Bitmap micon, string msg)
			{
				Pair<Bitmap, string>[] lines = new Pair<Bitmap, string>[files.Length];
				int counter = 0;
				foreach (File file in files)
				{
					Bitmap icon = null;
					string text = file.path1;
					switch (file.action)
					{
						case "created": icon = Properties.Resources.Created; break;
						case "deleted": icon = Properties.Resources.Deleted; break;
						case "changed": icon = Properties.Resources.Changed; break;
						case "renamed":
							icon = Properties.Resources.Renamed;
							text += " -> " + file.path2;
							break;
					}
					lines[counter] = new Pair<Bitmap, string>(icon, text);
					counter++;
				}
				ActivityLog.Current.AddEventLog(micon, msg + root + " [" + lines.Length.ToString() + "]", lines);
			}
		}


		public class ClientInfo
		{
			Socket socket;
			Server parent;
			byte[] dataBuffer = new byte[64*1024];

			public int id;
			public string type;
			public string agent;
			public string page;
			public string url;
			public bool muted;

			public ClientInfo(int id, Socket socket, Server parent)
			{
				this.id = id;
				this.socket = socket;
				this.parent = parent;
				this.muted = false;
				this.page = "";
				this.agent = "";
				this.type = "";
			}

			public string GetClientFriendlyName()
			{
				return string.Format("{0}[{1}]", Context.GetClientTypeString(type), id);
			}

			// this the call back function which will be invoked when the socket
			// detects any client writing of data on the stream
			public void OnDataReceived(IAsyncResult asyn)
			{
				try
				{
					int iRx = 0;
					// Complete the BeginReceive() asynchronous call by EndReceive() method
					// which will return the number of characters written to the stream 
					// by the client
					iRx = socket.EndReceive(asyn);
					if (iRx == 0)
					{
						// it seems client died unexpectedly
						Utils.LogException(GetClientFriendlyName() + ": broken connection.", new Exception("Received zero bytes."));
						parent.RemoveClient(id); // TODO: ?
						return;
					}

					char[] chars = new char[iRx + 1];
					System.Text.Decoder d = System.Text.Encoding.UTF8.GetDecoder();
					int charLen = d.GetChars(dataBuffer, 0, iRx, chars, 0);
					System.String data = new System.String(chars);

					ClientMessage message = (ClientMessage)JavaScriptConvert.DeserializeObject(data, typeof(ClientMessage));
					if (ProcessMessage(message))
					{
						// continue the waiting for data on the Socket
						WaitForData();
					}
				}
				catch (ObjectDisposedException e)
				{
					Utils.LogException(GetClientFriendlyName() + " closed socket without notice.", e);
					parent.RemoveClient(id); // TODO: ?
				}
				catch (SocketException e)
				{
					// fire exception when browser crashed
					Utils.LogException(GetClientFriendlyName() + " died without saying goodbye (crashed?)", e);
					parent.RemoveClient(id); // TODO: ?
				}
			}

			private bool ProcessMessage(ClientMessage message)
			{
				string log;
				switch (message.command)
				{
					case "Hello":
						type = message.type;
						if (type == null) type = "?";
						agent = message.agent;
						if (agent == null) agent = "?";
						log = String.Format("{0}: connected", GetClientFriendlyName());
						ActivityLog.Current.AddEventLog(Context.GetClientTypeIcon(type), log, Utils.LogLine(Properties.Resources.Information, agent));
						// reply with AboutMe message
						AssemblyName name = Assembly.GetExecutingAssembly().GetName();
						ServerMessageAbout msg = new ServerMessageAbout(Utils.GetVersionString(), name.Name);
						SendMessage(msg);
						break;
					case "Bye":
						parent.RemoveClient(id); // unregister from parent
						log = String.Format("{0}: disconnected", GetClientFriendlyName());
						ActivityLog.Current.AddEventLog(Context.GetClientTypeIcon(type), log);
						return false;
					case "SetPage":
						page = message.page;
						if (page == null) page = "";
						url = message.url;
						if (url == null) url = "";
						if (page.Length > 0)
						{
							log = String.Format("{0}: changed page to '{1}'", GetClientFriendlyName(), page);
							ActivityLog.Current.AddEventLog(Context.GetClientTypeIcon(type), log, Utils.LogLine(Properties.Resources.Information, url));
						}
						break;
				}
				Context.Current.UpdateTrayIcon();
				return true;
			}

			public void SendMessage(ServerMessage message)
			{
				// serialize message to JSON
				char[] data = JavaScriptConvert.SerializeObject(message).ToCharArray();

				// encode string into UTF-8
				System.Text.Encoder encoder = System.Text.Encoding.UTF8.GetEncoder();
				int bufferSize = encoder.GetByteCount(data, 0, data.Length, true);
				byte[] buffer = new byte[bufferSize];
				int charLen = encoder.GetBytes(data, 0, data.Length, buffer, 0, true);

				// send as UTF-8 string
				socket.Send(buffer);
			}

			// start waiting for data from the client
			public void WaitForData()
			{
				try
				{
					// start receiving any data written by the connected client asynchronously
					socket.BeginReceive(dataBuffer, 0, dataBuffer.Length, SocketFlags.None, new AsyncCallback(OnDataReceived), this);
				}
				catch (SocketException e)
				{
					// fire exception when browser crashed
					Utils.LogException(GetClientFriendlyName() + " failed to receive message.", e);
					parent.RemoveClient(id); // TODO: ?
				}
			}

			public void Toggle()
			{
				lock (this)
				{
					muted = !muted;
					if (muted)
						Utils.LogInfo(string.Format("{0}: muted by user", GetClientFriendlyName()));
					else
						Utils.LogInfo(string.Format("{0}: enabled by user", GetClientFriendlyName()));
				}
			}

			public void OnToggle(object sender, EventArgs e)
			{
				Toggle();
			}
		}

		/////////////////////////////////////////////////////////////////////////////////

		public static Server Current;

		Socket socket;
		public Dictionary<int, ClientInfo> clients = new Dictionary<int, ClientInfo>();
		int lastClientID = 0;

		public Server()
		{
			Current = this;
		}

		public void Start()
		{
			try {
				Model.SettingsRow settings = Context.Model.GetSettings();

				// create the listening socket
				socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
				IPAddress address = settings.LocalhostOnly ? IPAddress.Loopback : IPAddress.Any;
				IPEndPoint ipLocal = new IPEndPoint(address, settings.Port);

				// bind to local IP Address
				socket.Bind(ipLocal);

				// start listening
				socket.Listen(4);

				// create the call back for any client connections
				socket.BeginAccept(new AsyncCallback(OnClientConnect), null);

				// add notification into log
				ActivityLog.Current.AddEventLog(Properties.Resources.Information, "Started listening for browser connections");
			}
			catch (Exception e)
			{
				Utils.LogException("Server start failed.", e);
			}
		}

		public void Stop()
		{
			// add notification into log
			ActivityLog.Current.AddEventLog(Properties.Resources.Information, "Ended listening for browser connections");
		}

		public void AddClient(int id, ClientInfo client)
		{
			lock (this)
			{
				clients[lastClientID] = client;
			}
			Context.Current.UpdateTrayIcon();
		}

		public void RemoveClient(int id)
		{
			lock (this)
			{
				clients.Remove(id);
			}
			Context.Current.UpdateTrayIcon();
		}

		private void OnClientConnect(IAsyncResult asyn)
		{
			try
			{
				// here we complete/end the BeginAccept() asynchronous call
				// by calling EndAccept() - which returns the reference to a new Socket object
				ClientInfo client = new ClientInfo(++lastClientID, socket.EndAccept(asyn), this);
				AddClient(lastClientID, client);

				// let the worker Socket do the further processing for the just connected client
				client.WaitForData();

				// since the main Socket is now free, it can go back and wait for
				// other clients who are attempting to connect
				socket.BeginAccept(new AsyncCallback(OnClientConnect), null);
			}
			catch (ObjectDisposedException e)
			{
				Utils.LogException("Socket has been unexpectedly closed during client connection.", e);
				RemoveClient(lastClientID); // TODO: ?
			}
			catch (SocketException e)
			{
				Utils.LogException("Client died without saying goodbye (crashed?)", e);
				RemoveClient(lastClientID); // TODO: ?
			}
		}

		public bool IsAnyClientEnabled()
		{
			lock (this)
			{
				foreach (KeyValuePair<int, ClientInfo> pair in clients)
				{
					if (!pair.Value.muted) return true;
				}
			}
			return false;
		}

		public bool IsAnyClientConnected()
		{
			lock (this)
			{
				return clients.Count > 0;
			}
		}

		internal bool ToggleClient(int id)
		{
			lock (this)
			{
				if (!clients.ContainsKey(id)) return false;
				clients[id].Toggle();
				return true;
			}
		}

		internal bool SendRefresh()
		{
			// prepare pending messages
			// note: this will dump all recorded activities
			List<ServerMessageRefresh> messages = Context.Model.PrepareRefreshMessages();

			bool somethingSent = false;
			lock (this)
			{
				// send every message to every client
				foreach (ServerMessageRefresh message in messages)
				{
					foreach (KeyValuePair<int, ClientInfo> pair in clients)
					{
						ClientInfo client = pair.Value;
						if (!client.muted)
						{
							client.SendMessage(message);
							Context.Current.IncreaseRefreshCounter();
							somethingSent = true;
						}
					}
				}
			}
			return somethingSent;
		}
	}
}