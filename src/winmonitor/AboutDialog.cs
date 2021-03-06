using System;
using System.Diagnostics;
using System.Web;
using System.Windows.Forms;

namespace XRefresh
{
	public partial class AboutDialog: Form
	{
		public AboutDialog()
		{
			InitializeComponent();
			labelVersion.Text += " " + Utils.GetVersionString();

			int counter = Context.Current.RefreshCounter;
			float hours = ((float)counter) / (60 * 60);

			// i'm not able to format string properly using one format string :-(
			if (counter == 0)
			{
				labelStat1.Text = String.Format("XRefresh has not performed any refresh operation so far.");
			}
			else if (counter < 10)
			{
				labelStat1.Text = String.Format("XRefresh has performed {0,0} refresh operations so far.", counter);
			}
			else
			{
				labelStat1.Text = String.Format("XRefresh has performed {0:0,0} refresh operations so far.", counter);
			}
			if (hours >= 0.1)
			{
				labelStat2.Text = String.Format("That counts for more than {0:0.0} hours of your precious time.", hours);
				labelThanks.Text = "thank you for using this software";
			}
			else
			{
				labelStat2.Text = "";
				labelThanks.Text = "";
			}
		}

		private void buttonOK_Click(object sender, EventArgs e)
		{
			Close();
		}

		private void linkLabelContact_LinkClicked(object sender, LinkLabelLinkClickedEventArgs e)
		{
			string email = "antonin@hildebrand.cz";
			string subject = "Feedback";
			string body = "Enter your text here and send this mail to antonin@hildebrand.cz";
			string message = string.Format("mailto:{0}?subject={1}&body={2}", email, subject, body);
			Process.Start(message);
		}

		private void linkLabelSite_LinkClicked(object sender, LinkLabelLinkClickedEventArgs e)
		{
			string message = "http://xrefresh.com";
			Process.Start(message);
		 }

		private void linkLabelAbout_LinkClicked(object sender, LinkLabelLinkClickedEventArgs e)
		{
			string message = "http://xrefresh.com/about";
			Process.Start(message);
		}
	}
}